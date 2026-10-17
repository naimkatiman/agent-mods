// enhance mod: the prompt-enhancer port (claude-mods/prompt-enhancer).
//
// The original forked the live Claude thread ($.model.fork) to rewrite a draft and put the result in
// the prompt box. No other agent offers either, so here the calling agent writes the rewrite itself,
// in its own context, from the same meta-prompt (the enhance skill: prepare -> answer -> offer), and
// the user sends it as is or pastes an edit. No model call anywhere in this module.
//
// Store: projects/<projectId>/taste.json = { v: 1, records: [{ edited, delta, rewrite?, sent?, agent,
// at }] } (last KEEP), shared by every worktree and agent of the repo; sessions/<key>/enhance.json =
// { v: 1, offer, last } holds the session's one pending offer.
import fs from 'node:fs'
import path from 'node:path'
import { randomId } from '../core/fsx.mjs'
import { listRecords, resolveCallerSession } from '../core/session-records.mjs'
import { projectFile, sessionKey, sessionState, touchProjectMeta } from '../core/store.mjs'
import { agoText, plural, sanitize } from '../core/text.mjs'
import {
  KEEP,
  MARK,
  OFFER_TTL_MS,
  SIMILAR,
  buildAsk,
  fingerprint,
  makeOffer,
  normText,
  overlap,
  recordFrom,
  redact,
  tasteHint,
} from './enhance-logic.mjs'

const STATE = 'enhance'

function tasteRel(projectId) {
  return projectFile({ projectId }, 'taste.json')
}

export function loadTaste(store, projectId) {
  const data = store.readJson(tasteRel(projectId), null)
  const list = Array.isArray(data?.records) ? data.records : []
  // A hand-edited or foreign record must not break the next rewrite.
  return list
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({ ...r, edited: r.edited === true, delta: Number.isFinite(r.delta) ? r.delta : 0 }))
}

// Under the file lock: two agents recording at once must not drop each other's record.
function appendTaste(store, projectId, record) {
  const next = store.update(tasteRel(projectId), { v: 1, records: [] }, (current) => ({
    v: 1,
    records: [...(Array.isArray(current?.records) ? current.records : []), record].slice(-KEEP),
  }))
  return next.records.length
}

export function clearTaste(store, projectId) {
  let cleared = 0
  store.update(tasteRel(projectId), null, (current) => {
    cleared = Array.isArray(current?.records) ? current.records.length : 0
    return current ? { v: 1, records: [] } : undefined
  })
  return cleared
}

function expired(offer, now) {
  return now - (offer.createdAt ?? 0) > OFFER_TTL_MS
}

function closed(offer, outcome, now) {
  return { v: 1, offer: null, last: { offerId: offer.offerId, outcome, at: now } }
}

// Takes the offer for recording under the state file's lock, so the prompt hook and a tool call
// (two processes) can never both record it.
function claimOffer(state, offerId, now) {
  let claimed = null
  state.update((current) => {
    const offer = current?.offer
    if (!offer || (offerId && offer.offerId !== offerId)) return undefined
    if (expired(offer, now)) return closed(offer, 'expired', now)
    claimed = offer
    return closed(offer, 'recorded', now)
  }, null)
  return claimed
}

// The tool can resolve a different session than the one that made the offer (two sessions of one
// agent in one worktree, no session id in the MCP env); an explicit offer id finds it anywhere.
function claimOfferAnywhere(store, offerId, now) {
  for (const entry of store.list('sessions')) {
    if (!entry.isDirectory()) continue
    const state = sessionState(store, entry.name, STATE)
    if (state.read(null)?.offer?.offerId === offerId) return claimOffer(state, offerId, now)
  }
  return null
}

// Offers live in the calling session's state, where its UserPromptSubmit hook looks. When the caller
// cannot be identified, a per-worktree slot still lets offer and record find each other.
function fallbackKey(agent, project) {
  return sessionKey(agent || 'any', `enhance-${project.worktreeId}`)
}

export function prepare(store, project, agent, draftText) {
  const draft = normText(draftText)
  if (!draft) return { error: 'Type a prompt first' }
  const records = loadTaste(store, project.projectId)
  const taste = tasteHint(records)
  return { ask: buildAsk(agent, taste, draft), taste, records: records.length }
}

export function storeOffer(store, project, { key, agent, draft, reply, now }) {
  const made = makeOffer({ offerId: randomId(4), draft, reply, now, agent, projectId: project.projectId })
  if (!made) return { error: 'Enhance failed: empty reply' }
  touchProjectMeta(store, project, now)
  // One offer per session: a new rewrite replaces the last, as a new Enhance did.
  sessionState(store, key, STATE).update(() => ({ v: 1, offer: made.offer }), null)
  return { offer_id: made.offer.offerId, text: made.text, notes: made.notes }
}

// `sent: null` = the caller says the rewrite went out unchanged (CLI --unchanged).
export function recordSent(store, { key, offerId, sent, agent, now }) {
  const state = sessionState(store, key, STATE)
  const offer = claimOffer(state, offerId, now) ?? (offerId ? claimOfferAnywhere(store, offerId, now) : null)
  if (!offer) {
    const last = state.read(null)?.last ?? null
    return { recorded: false, edited: false, delta: 0, last: !offerId || last?.offerId === offerId ? last : null }
  }
  const rec = recordFrom(offer, sent, agent, now)
  const kept = appendTaste(store, offer.projectId, rec)
  return { recorded: true, edited: rec.edited, delta: rec.delta, kept }
}

// UserPromptSubmit: learn from what the user actually sent while an offer is pending. Prints nothing.
function onPrompt(ctx) {
  const { ev, now } = ctx
  // Claude marks prompts it did not get from the user (sdk, loop and schedule wakeups); the other
  // agents send no source, so theirs count. A subagent's prompt is never the user's.
  if (ev.isSubagent || (ev.source !== null && ev.source !== 'user')) return
  const state = ctx.session.state(STATE)
  if (!state.read(null)?.offer) return
  const prompt = normText(ev.prompt)
  if (!prompt) return
  let rec = null
  let projectId = null
  state.update((current) => {
    const offer = current?.offer
    if (!offer) return undefined
    if (expired(offer, now)) return closed(offer, 'expired', now)
    // The reply to the offer already went by without matching it: the user has moved on.
    if (offer.answeredAt) return closed(offer, 'dropped', now)
    // Invoking the skill again (/enhance, Codex $enhance, Cascade @enhance) asks for a new rewrite,
    // even when its draft is the old rewrite: never a send of it.
    const again = /^[/$@]enhance\b/i.test(prompt)
    if (!again && (fingerprint(prompt) === offer.fingerprint || overlap(redact(prompt), offer.rewrite) >= SIMILAR)) {
      rec = recordFrom(offer, prompt, ev.agent, now)
      projectId = offer.projectId ?? ctx.project.projectId
      return closed(offer, 'recorded', now)
    }
    // Neither the rewrite nor an edit of it: never compared again (the original compared every later
    // prompt with a stale rewrite). An explicit record can still claim it until the next prompt,
    // because "send as is" is itself a prompt that matches nothing.
    return { ...current, offer: { ...offer, answeredAt: now } }
  }, null)
  if (rec) appendTaste(ctx.store, projectId, rec)
}

function onEnd(ctx) {
  const state = ctx.session.state(STATE)
  if (!state.read(null)?.offer) return
  state.update((current) => (current?.offer ? closed(current.offer, 'dropped', ctx.now) : undefined), null)
}

const OUTCOME = { recorded: 'was already recorded', dropped: 'was dropped (the user moved on)', expired: 'expired' }

function recordText(result, project) {
  if (!result.recorded) {
    const why = result.last ? `Offer ${result.last.offerId} ${OUTCOME[result.last.outcome] ?? result.last.outcome}.` : 'No live offer in this session (already recorded, dropped or expired).'
    return `Nothing recorded. ${why}`
  }
  const what = result.edited ? `edited, ${result.delta >= 0 ? '+' : ''}${result.delta} characters` : 'sent unchanged'
  return `Recorded (${what}). ${plural(result.kept, 'rewrite')} in the taste history of ${project.name}.`
}

function offerLines(text, notes) {
  return [text, ...(notes.length ? ['', ...notes.map((n) => `+ ${n}`)] : [])].join('\n')
}

const ACTIONS = ['prepare', 'offer', 'record', 'taste', 'clear']

function toolSession(m, args, project) {
  const caller = m.caller(args, project)
  const agent = m.agent ?? caller?.agent ?? null
  return { key: caller?.key ?? fallbackKey(agent, project), agent }
}

function runTool(args, m) {
  const project = m.project(args.cwd)
  switch (args.action) {
    case 'prepare': {
      const result = prepare(m.store, project, m.agent, args.draft)
      if (result.error) return { text: result.error, isError: true }
      return {
        text: `${result.ask}\n\n(Answer the request above yourself, from what you know of this project and conversation, using no tools. Then call this tool with action "offer", the same draft, and your whole reply as \`reply\`.)`,
        data: result,
      }
    }
    case 'offer': {
      const { key, agent } = toolSession(m, args, project)
      const result = storeOffer(m.store, project, { key, agent, draft: args.draft, reply: args.reply, now: m.now })
      if (result.error) return { text: result.error, isError: true }
      return {
        text: `Offer ${result.offer_id}. Show the user this rewrite and its notes, then stop and ask: "Send as is, or paste your edited version." Do not carry it out until they answer.\n\n${offerLines(result.text, result.notes)}`,
        data: result,
      }
    }
    case 'record': {
      if (!normText(args.sent)) return { text: 'record needs `sent`: what the user sent (the rewrite itself if they said send as is).', isError: true }
      const { key, agent } = toolSession(m, args, project)
      const result = recordSent(m.store, { key, offerId: args.offer_id, sent: args.sent, agent, now: m.now })
      const { recorded, edited, delta } = result
      const kept = result.kept ?? loadTaste(m.store, project.projectId).length
      return { text: recordText(result, project), data: { recorded, edited, delta, kept } }
    }
    case 'taste': {
      const records = loadTaste(m.store, project.projectId)
      const hint = tasteHint(records)
      const shown = records.map((r) => ({ ...r, ...(r.edited ? { rewrite: sanitize(r.rewrite ?? ''), sent: sanitize(r.sent ?? '') } : {}) }))
      return { text: hint || `No taste history yet for ${project.name}.`, data: { records: shown, hint } }
    }
    case 'clear': {
      const cleared = clearTaste(m.store, project.projectId)
      return { text: cleared ? `Cleared ${plural(cleared, 'taste record')} for ${project.name}.` : `No taste history for ${project.name}.`, data: { cleared } }
    }
    default:
      return { text: `Unknown action: ${args.action}. Use one of ${ACTIONS.join(', ')}.`, isError: true }
  }
}

// Run from an agent's shell (the skill's fallback without MCP), the offer belongs to that session, so
// its prompt hook sees the user's answer. From a plain terminal it goes to the fallback slot.
function cliSessionKey(c, agent) {
  const id = typeof c.flags.session === 'string' ? c.flags.session : null
  if (id && !agent) {
    // An explicit id names one session; never guess another agent's newest session for it.
    return listRecords(c.store).find((r) => r.id === id)?.key ?? sessionKey('any', id)
  }
  const caller = agent ? resolveCallerSession(c.store, { agent, sessionId: id, env: c.env, project: c.project, now: c.now }) : null
  return caller?.key ?? fallbackKey(agent, c.project)
}

// --name <file> or --name - (stdin). PowerShell's Out-File and Set-Content -Encoding utf8 add a BOM.
function readInput(c, name) {
  const value = c.flags[name]
  if (typeof value !== 'string' || !value) return { text: null }
  try {
    const text = value === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(c.cwd, value), 'utf8')
    return { text: text.replace(/^\uFEFF/, '') }
  } catch (err) {
    return { error: `Cannot read --${name} ${value}: ${err.message}` }
  }
}

const USAGE = [
  'agent-mods enhance prepare <draft...> [--agent claude|codex|grok|devin] [--json]',
  '    print the rewrite request for a rough prompt; answer it yourself or pipe it to a model (claude -p)',
  'agent-mods enhance offer --reply <file|-> [--draft <file|->] [--session <id>] [--json]',
  `    keep a rewrite (the reply: rewrite, a line ${MARK}, 1-3 bullets) for the user to review`,
  'agent-mods enhance record (--sent <file|-> | --unchanged) [--offer <id>] [--session <id>] [--json]',
  '    record what the user sent, so later rewrites learn their taste',
  'agent-mods enhance taste [--json]    this project\'s taste history and the hint the next rewrite gets',
  'agent-mods enhance clear             forget this project\'s taste history',
  'All take --cwd <dir> (default: the current folder).',
].join('\n')

function cliPrepare(c, words) {
  let draft = words.join(' ')
  if (!draft.trim() && c.flags.draft) {
    const input = readInput(c, 'draft')
    if (input.error) return fail(c, input.error, 1)
    draft = input.text ?? ''
  }
  const result = prepare(c.store, c.project, c.agent, draft)
  if (result.error) return fail(c, result.error, 1)
  if (c.json) c.printJson(result)
  else c.print(result.ask)
  return 0
}

function cliOffer(c) {
  if (c.flags.reply === '-' && c.flags.draft === '-') return fail(c, 'Only one of --draft and --reply can read stdin (-).', 2)
  const reply = readInput(c, 'reply')
  if (reply.error) return fail(c, reply.error, 1)
  if (reply.text === null) return fail(c, USAGE, 2)
  const draft = readInput(c, 'draft')
  if (draft.error) return fail(c, draft.error, 1)
  const agent = c.agent
  const result = storeOffer(c.store, c.project, { key: cliSessionKey(c, agent), agent, draft: draft.text ?? '', reply: reply.text, now: c.now })
  if (result.error) return fail(c, result.error, 1)
  if (c.json) c.printJson(result)
  else c.print(`${offerLines(result.text, result.notes)}\n\noffer ${result.offer_id}: send as is, or paste your edited version.`)
  return 0
}

function cliRecord(c) {
  let sent = null
  if (!c.flags.unchanged) {
    const input = readInput(c, 'sent')
    if (input.error) return fail(c, input.error, 1)
    if (!normText(input.text)) return fail(c, USAGE, 2)
    sent = input.text
  }
  const agent = c.agent
  const offerId = typeof c.flags.offer === 'string' ? c.flags.offer : undefined
  const result = recordSent(c.store, { key: cliSessionKey(c, agent), offerId, sent, agent, now: c.now })
  const kept = result.kept ?? loadTaste(c.store, c.project.projectId).length
  if (c.json) c.printJson({ recorded: result.recorded, edited: result.edited, delta: result.delta, kept })
  else c.print(recordText({ ...result, kept }, c.project))
  return 0
}

function cliTaste(c) {
  const records = loadTaste(c.store, c.project.projectId)
  const hint = tasteHint(records)
  if (c.json) {
    c.printJson({ records, hint })
    return 0
  }
  if (!records.length) {
    c.print(`No taste history yet for ${c.project.name}.`)
    return 0
  }
  c.print(`${c.project.name}: ${plural(records.length, 'rewrite')} remembered (the last ${KEEP} are kept)`)
  for (const r of records) {
    const what = r.edited ? `edited, ${r.delta >= 0 ? '+' : ''}${r.delta} characters` : 'sent unchanged'
    c.print(`  ${agoText(r.at ?? 0, c.now).padEnd(9)} ${String(r.agent ?? '?').padEnd(7)} ${what}`)
  }
  c.print('')
  c.print('The next rewrite gets:')
  c.print(hint)
  return 0
}

function fail(c, message, code) {
  c.error(message)
  return code
}

export default {
  name: 'enhance',
  hooks: {
    UserPromptSubmit: onPrompt,
    SessionEnd: onEnd,
  },
  tools: [
    {
      name: 'enhance',
      description:
        'Prompt enhancer (see the enhance skill). prepare: the rewrite request for a rough draft, which you answer yourself without tools. offer: keep your reply and get the rewrite to show the user. record: what the user then sent, so later rewrites learn their taste. taste: that history. clear: forget it.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ACTIONS },
          draft: { type: 'string', description: 'prepare, offer: the rough prompt' },
          reply: { type: 'string', description: `offer: your rewrite, a line ${MARK}, then 1-3 bullets` },
          sent: { type: 'string', description: 'record: what the user sent (the rewrite itself if they said send as is)' },
          offer_id: { type: 'string', description: 'record: the id offer returned' },
          cwd: { type: 'string', description: 'your working directory' },
        },
        required: ['action'],
      },
      run: runTool,
    },
  ],
  cli: [
    {
      name: 'enhance',
      summary: 'Prompt enhancer: prepare | offer | record | taste | clear',
      usage: USAGE,
      run(c) {
        const [sub, ...rest] = c.positionals
        if (sub === 'prepare') return cliPrepare(c, rest)
        if (sub === 'offer') return cliOffer(c)
        if (sub === 'record') return cliRecord(c)
        if (sub === 'taste') return cliTaste(c)
        if (sub === 'clear') {
          const cleared = clearTaste(c.store, c.project.projectId)
          if (c.json) c.printJson({ cleared })
          else c.print(cleared ? `Cleared ${plural(cleared, 'taste record')} for ${c.project.name}.` : `No taste history for ${c.project.name}.`)
          return 0
        }
        return fail(c, USAGE, 2)
      },
    },
  ],
}
