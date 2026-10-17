// design mod: claude-mods design-direction for every agent. A design question goes to a browser
// picker that draws each option's SVG mockup (the agent-mods `design_pick` tool), and every pick is
// remembered per repo in projects/<id>/design.json, so all agents and worktrees on the repo build to
// the same decisions: they reach the model at session start, and picks made by another session reach
// it on the next prompt. Picks live in projects/<id>/design-picks/<pickId>/ while they are open.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { agentFromName } from '../core/agents.mjs'
import { pidAlive, randomId } from '../core/fsx.mjs'
import { logError, projectFile, touchProjectMeta } from '../core/store.mjs'
import { agentLabel, sanitize } from '../core/text.mjs'
import { decisionsOf, galleryHtml, isSvg, mergeDecisions, sameDecision } from './design-gallery.mjs'

// register.tsx:12-15 word for word, except the sentence that named AskUserQuestion and its `preview`
// field. It ships in skills/design-decisions/SKILL.md (the tests keep the two identical) and comes back
// with a design_pick call whose mockups are not SVG.
export const GUIDANCE = `# Visual design direction
Whenever you ask the user to choose a design direction (visual style, layout, palette, typography, component look, hero treatment, density, mood…), call the agent-mods \`design_pick\` tool and give EVERY option an \`svg\` that is one self-contained SVG document drawing that direction:
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300">…</svg>
Draw the real thing: actual colors, type (font-family, sizes, weights), layout blocks, sample copy, buttons. Not a description of it. Make the options visibly different from each other. No scripts, no external images or font links, under ~8 KB each. The user sees all options rendered side by side and picks one visually.`

export const DENY = 'The user closed the design-direction picker without choosing. Ask what they want instead.'
export const NEW_DECISIONS = 'New design decisions made in another session on this project — follow them:'
const READ_FAILED = 'design-direction: could not read the remembered design decisions.'

export const PICK_SERVER_MS = 30 * 60_000
const PICK_KEEP_MS = 24 * 3_600_000
// A pick folder with no meta.json yet is being created; only older ones are debris.
const UNFINISHED_MS = 60_000
const WAIT_DEFAULT_S = 40
const WAIT_MAX_S = 50
const POLL_MS = 100
const PICK_ID = /^[0-9a-f]{12}$/
const MAX_SVG_BYTES = 16 * 1024
const MAX_TEXT = 4000

const SERVERS = new Map()

// Decision text can come from another agent's session: one line each, no control characters.
const flat = (s) => sanitize(String(s ?? '').replace(/\s+/g, ' ').trim())

function decisionLine(d) {
  const description = d.description ? flat(d.description) : ''
  return `${flat(d.question)} → ${flat(d.choice)}${description ? ` (${description})` : ''}`
}

export function decisionsPrompt(ds) {
  return `# Design decisions already made in this project — follow them and don't re-ask
The user already chose these design directions here. Keep new questions, mockups and builds consistent with them; only ask again if the user asks to revisit one.
${ds.map((d) => `- ${decisionLine(d)}`).join('\n')}`
}

export function listText(ds, where) {
  if (!ds.length) return `No design decisions remembered for ${where} yet.`
  return `Design decisions for ${where}:\n${ds.map((d, i) => `${i + 1}. ${decisionLine(d)}`).join('\n')}`
}

export function forgotText(n, where) {
  return `Forgot ${n} design decision${n === 1 ? '' : 's'} for ${where}.`
}

const isText = (s) => typeof s === 'string' && s.trim() !== ''
const normTopic = (t) => (isText(t) ? t.trim().toLowerCase() : undefined)
const newestAt = (ds) => ds.reduce((max, d) => Math.max(max, Number(d.at) || 0), 0)

export function loadDecisions(store, project) {
  const got = store.readJson(projectFile(project, 'design.json'), null)
  return Array.isArray(got?.decisions) ? got.decisions : []
}

export function addDecisions(store, project, added) {
  return store.update(projectFile(project, 'design.json'), null, (cur) => ({
    v: 1,
    decisions: mergeDecisions(Array.isArray(cur?.decisions) ? cur.decisions : [], added),
  })).decisions
}

// All of them, or the ones matching a question text or a topic. Returns how many were dropped.
export function forgetDecisions(store, project, { question, topic } = {}) {
  const t = normTopic(topic)
  const q = isText(question) ? question : undefined
  let removed = 0
  store.update(projectFile(project, 'design.json'), null, (cur) => {
    const list = Array.isArray(cur?.decisions) ? cur.decisions : []
    const keep = q || t ? list.filter((d) => !((t && d.topic === t) || (q && d.question === q))) : []
    removed = list.length - keep.length
    return removed ? { v: 1, decisions: keep } : undefined
  })
  return removed
}

// A decision the user gave outside the picker (in chat, or typed into the CLI).
function recordDecision(store, project, input, { at, agent, sessionKey }) {
  for (const key of ['question', 'choice']) {
    if (!isText(input[key])) return { error: `${key} is required.` }
  }
  for (const key of ['question', 'choice', 'description', 'topic']) {
    if (input[key] !== undefined && input[key] !== null && (typeof input[key] !== 'string' || input[key].length > MAX_TEXT)) {
      return { error: `${key} must be text of at most ${MAX_TEXT} characters.` }
    }
  }
  const topic = normTopic(input.topic)
  const description = isText(input.description) ? input.description.trim() : ''
  const saved = {
    question: input.question,
    ...(topic ? { topic } : {}),
    choice: input.choice.trim(),
    ...(description ? { description } : {}),
    at,
    agent: agent ?? null,
    sessionKey: sessionKey ?? null,
  }
  addDecisions(store, project, [saved])
  return { saved }
}

// The tool's input checked against its schema (the MCP core does not validate). Values are kept
// exactly as given: answers come back keyed by the question text the model sent.
export function validateQuestions(input) {
  const fail = (error) => ({ error })
  if (!Array.isArray(input) || input.length < 1 || input.length > 4) return fail('questions must be an array of 1 to 4 questions.')
  const out = []
  const seen = new Set()
  for (const [qi, q] of input.entries()) {
    const at = `questions[${qi}]`
    if (!q || typeof q !== 'object') return fail(`${at} must be an object.`)
    if (!isText(q.question) || q.question.length > MAX_TEXT) return fail(`${at}.question is required (at most ${MAX_TEXT} characters).`)
    if (seen.has(q.question)) return fail(`${at}.question repeats another question; answers are keyed by question text.`)
    seen.add(q.question)
    if (!isText(q.header) || q.header.length > 40) return fail(`${at}.header is required, at most 40 characters.`)
    if (q.topic !== undefined && q.topic !== null && typeof q.topic !== 'string') return fail(`${at}.topic must be text.`)
    if (q.multiSelect !== undefined && q.multiSelect !== null && typeof q.multiSelect !== 'boolean') return fail(`${at}.multiSelect must be true or false.`)
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) return fail(`${at}.options must hold 2 to 6 options.`)
    const labels = new Set()
    const options = []
    for (const [oi, o] of q.options.entries()) {
      const ot = `${at}.options[${oi}]`
      if (!o || typeof o !== 'object') return fail(`${ot} must be an object.`)
      if (!isText(o.label) || o.label.length > 60) return fail(`${ot}.label is required, at most 60 characters.`)
      if (labels.has(o.label)) return fail(`${ot}.label repeats another option's label.`)
      labels.add(o.label)
      const hasDescription = o.description !== undefined && o.description !== null && o.description !== ''
      if (hasDescription && (typeof o.description !== 'string' || o.description.length > 200)) return fail(`${ot}.description must be text of at most 200 characters.`)
      const hasSvg = o.svg !== undefined && o.svg !== null && o.svg !== ''
      if (hasSvg && !isSvg(o.svg)) return fail(`${ot}.svg must be one SVG document that starts with <svg (an <?xml ...?> prolog is fine).\n\n${GUIDANCE}`)
      if (hasSvg && Buffer.byteLength(o.svg, 'utf8') > MAX_SVG_BYTES) return fail(`${ot}.svg is over 16 KB; draw a simpler mockup.`)
      options.push({ label: o.label, ...(hasDescription ? { description: o.description } : {}), ...(hasSvg ? { svg: o.svg } : {}) })
    }
    const topic = normTopic(q.topic)
    out.push({ question: q.question, header: q.header, ...(topic ? { topic } : {}), multiSelect: q.multiSelect === true, options })
  }
  return { questions: out }
}

const picksDir = (project) => projectFile(project, 'design-picks')
const pickDir = (project, pickId) => `${picksDir(project)}/${pickId}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function serverAlive(meta, now) {
  if (!meta || meta.closedAt || !(now < meta.expiresAt)) return false
  return meta.pid === process.pid ? SERVERS.has(meta.pickId) : pidAlive(meta.pid)
}

// The pick's answer, recorded in design.json exactly once by whoever sees it first: the server on
// POST, a waiting design_pick in any process, or gc. null while nobody has answered.
function settlePick(store, project, pickId) {
  const dir = pickDir(project, pickId)
  const answer = store.readJson(`${dir}/answer.json`, null)
  if (!answer || typeof answer !== 'object') return null
  if (answer.closed === true) return { status: 'closed', message: DENY }
  const answers = answer.answers && typeof answer.answers === 'object' && !Array.isArray(answer.answers) ? answer.answers : {}
  const questions = store.readJson(`${dir}/questions.json`, null)
  const decisions = Array.isArray(questions) ? decisionsOf(questions, answers, Number(answer.at) || Date.now()) : []
  if (store.exists(`${dir}/meta.json`)) {
    store.update(`${dir}/meta.json`, null, (meta) => {
      if (!meta || meta.recordedAt) return undefined
      if (decisions.length) addDecisions(store, project, decisions.map((d) => ({ ...d, agent: meta.agent ?? null, sessionKey: meta.sessionKey ?? null })))
      return { ...meta, recordedAt: Date.now() }
    })
  }
  return { status: 'answered', answers, decisions }
}

function pendingResult(pickId, url) {
  return {
    status: 'pending',
    pick_id: pickId,
    url,
    message: `The design picker is open at ${url} and the user has not picked yet. Tell the user the link in one line, then call design_pick again with pick_id "${pickId}" to keep waiting.`,
  }
}

function expiredResult(pickId) {
  return {
    status: 'expired',
    pick_id: pickId,
    message: `Design picker ${pickId} is no longer open (it timed out or the process serving it ended) and nobody answered it. Ask the user in chat, or call design_pick with the questions again.`,
  }
}

// Waits up to waitMs for the pick's answer.json, which may come from a server in another process.
async function awaitPick(store, project, pickId, waitMs) {
  const deadline = Date.now() + waitMs
  for (;;) {
    const settled = settlePick(store, project, pickId)
    if (settled) return settled
    const meta = store.readJson(`${pickDir(project, pickId)}/meta.json`, null)
    // A server closes right after its answer, so look for the answer once more before calling it gone.
    if (!serverAlive(meta, Date.now())) return settlePick(store, project, pickId) ?? expiredResult(pickId)
    const left = deadline - Date.now()
    if (left <= 0) return pendingResult(pickId, meta.url)
    await sleep(Math.min(POLL_MS, left))
  }
}

// An open pick (any process) that already asks every one of these questions: reuse it, no second tab.
function findOpenPick(store, project, questions, now) {
  for (const entry of store.list(picksDir(project))) {
    if (!entry.isDirectory() || !PICK_ID.test(entry.name)) continue
    const dir = pickDir(project, entry.name)
    if (store.exists(`${dir}/answer.json`)) continue
    const meta = store.readJson(`${dir}/meta.json`, null)
    if (!serverAlive(meta, now)) continue
    const asked = store.readJson(`${dir}/questions.json`, null)
    if (Array.isArray(asked) && questions.every((q) => asked.some((a) => sameDecision(a, q)))) return meta
  }
  return null
}

// Pick ids are global, so a follow-up call finds its pick even when it passes another cwd.
function locatePick(store, pickId, preferred) {
  if (!PICK_ID.test(pickId)) return null
  if (preferred && store.exists(pickDir(preferred, pickId))) return preferred
  for (const entry of store.list('projects')) {
    if (entry.isDirectory() && store.exists(pickDir({ projectId: entry.name }, pickId))) return { projectId: entry.name }
  }
  return null
}

async function createPick({ store, project, questions, agent, sessionKey, env, log }) {
  // Loaded here, not at the top: node:http and child_process add ~30 ms to every hook process, and
  // hooks never open a picker.
  const { openBrowser, startPickServer } = await import('./design-server.mjs')
  const pickId = randomId(6)
  const dir = pickDir(project, pickId)
  const nonce = crypto.randomBytes(16).toString('base64')
  const token = crypto.randomBytes(16).toString('hex')
  const createdAt = Date.now()
  const server = await startPickServer({
    html: galleryHtml(questions, { token, nonce, agent: agent ? agentLabel(agent) : null, project: project.name }),
    nonce,
    token,
    answerFile: store.path(dir, 'answer.json'),
    questions: questions.map((q) => q.question),
    lifetimeMs: PICK_SERVER_MS,
    onAnswer: () => {
      try {
        settlePick(store, project, pickId)
      } catch (err) {
        log(`design: recording pick ${pickId}: ${err?.stack ?? err}`)
      }
    },
    onClose: () => {
      SERVERS.delete(pickId)
      try {
        if (store.exists(`${dir}/meta.json`)) store.update(`${dir}/meta.json`, null, (meta) => (meta ? { ...meta, closedAt: Date.now() } : undefined))
      } catch (err) {
        log(`design: closing pick ${pickId}: ${err?.stack ?? err}`)
      }
    },
  })
  SERVERS.set(pickId, server)
  try {
    // Questions first: an answer can only be recorded once meta.json exists, and by then it can be
    // matched to them. gc leaves a young folder without meta.json alone.
    // The mockups stay in the served page only: nothing after this needs them, and they can hold product copy.
    store.writeJson(`${dir}/questions.json`, questions.map(({ options, ...q }) => ({ ...q, options: options.map(({ svg, ...o }) => o) })))
    store.writeJson(`${dir}/meta.json`, {
      v: 1,
      pickId,
      url: server.url,
      createdAt,
      expiresAt: createdAt + PICK_SERVER_MS,
      agent: agent ?? null,
      sessionKey: sessionKey ?? null,
      pid: process.pid,
    })
  } catch (err) {
    server.close()
    throw err
  }
  openBrowser(server.url, env)
  return { pickId, url: server.url }
}

// Opens a picker for these questions, or answers without one: already decided (unless force), or an
// open picker for the same questions. { done } carries a final result.
async function startPick({ store, project, questions, force, agent, sessionKey, env, log }) {
  if (!force) {
    const decided = loadDecisions(store, project)
    const matched = questions.map((q) => decided.findLast((d) => sameDecision(d, q)))
    if (matched.every(Boolean)) return { done: { status: 'already_decided', decisions: [...new Set(matched)] } }
  }
  const now = Date.now()
  const open = findOpenPick(store, project, questions, now)
  if (open) return { pickId: open.pickId, url: open.url, reused: true }
  try {
    gcPicks(store, project, now)
  } catch (err) {
    log(`design: gc before a new pick: ${err?.stack ?? err}`)
  }
  try {
    touchProjectMeta(store, project, now)
  } catch {}
  return createPick({ store, project, questions, agent, sessionKey, env, log })
}

export function gcPicks(store, project, now = Date.now()) {
  let removed = 0
  for (const entry of store.list(picksDir(project))) {
    if (!entry.isDirectory()) continue
    const dir = pickDir(project, entry.name)
    const meta = store.readJson(`${dir}/meta.json`, null)
    let createdAt = Number(meta?.createdAt)
    if (!Number.isFinite(createdAt)) {
      try {
        createdAt = fs.statSync(store.path(dir)).mtimeMs
      } catch {
        continue
      }
    }
    const answered = store.exists(`${dir}/answer.json`)
    const abandoned = !answered && (meta ? !serverAlive(meta, now) : now - createdAt > UNFINISHED_MS)
    if (!abandoned && now - createdAt <= PICK_KEEP_MS) continue
    if (answered && meta && !meta.recordedAt) {
      try {
        settlePick(store, project, entry.name)
      } catch {
        // Locked out this time: keep the folder so the next gc records the answer instead of losing it.
        continue
      }
    }
    try {
      store.remove(dir)
      removed++
    } catch {
      // Windows refuses while another process has a file open in it; the next gc gets it.
    }
  }
  return removed
}

// Closes every picker server this process owns.
export function stopPickServers() {
  for (const server of [...SERVERS.values()]) server.close()
}

function resultText(r) {
  if (r.status === 'answered') {
    const lines = Object.entries(r.answers).filter(([, a]) => String(a).trim()).map(([q, a]) => `- ${flat(q)} → ${flat(a)}`)
    return `The user picked in the design-direction picker:\n${lines.join('\n')}\nThese are now this project's design decisions.`
  }
  if (r.status === 'already_decided') {
    return `Already decided in this project; follow it (call design_pick with force: true only if the user asks to revisit):\n${r.decisions.map((d) => `- ${decisionLine(d)}`).join('\n')}`
  }
  return r.message
}

function waitSeconds(value) {
  const n = Number(value)
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return WAIT_DEFAULT_S
  return Math.min(WAIT_MAX_S, Math.max(0, Math.floor(n)))
}

function callerKey(m, args, project) {
  try {
    return m.caller(args, project)?.key ?? null
  } catch {
    return null
  }
}

async function designPickTool(args, m) {
  const waitMs = waitSeconds(args.wait_seconds) * 1000
  if (isText(args.pick_id)) {
    const pickId = args.pick_id.trim()
    const project = locatePick(m.store, pickId, m.project(args.cwd))
    const result = project ? await awaitPick(m.store, project, pickId, waitMs) : expiredResult(pickId)
    return { text: resultText(result), data: result }
  }
  const checked = validateQuestions(args.questions)
  if (checked.error) return { text: `design_pick: ${checked.error}`, isError: true }
  const project = m.project(args.cwd)
  const started = await startPick({
    store: m.store,
    project,
    questions: checked.questions,
    force: args.force === true,
    agent: m.agent,
    sessionKey: callerKey(m, args, project),
    env: m.env,
    log: m.log,
  })
  const result = started.done ?? (await awaitPick(m.store, project, started.pickId, waitMs))
  return { text: resultText(result), data: result }
}

function designDecisionsTool(args, m) {
  const project = m.project(args.cwd)
  const where = project.repoKey
  const action = args.action ?? 'list'
  if (action === 'list') {
    const decisions = loadDecisions(m.store, project)
    const text = listText(decisions, where)
    return { text, data: { decisions, prompt: decisions.length ? decisionsPrompt(decisions) : '', text } }
  }
  if (action === 'record') {
    const { saved, error } = recordDecision(m.store, project, args, { at: m.now, agent: m.agent, sessionKey: callerKey(m, args, project) })
    if (error) return { text: `design_decisions: ${error}`, isError: true }
    try {
      touchProjectMeta(m.store, project, m.now)
    } catch {}
    const text = `Remembered for ${where}: ${decisionLine(saved)}`
    return { text, data: { saved, text } }
  }
  if (action === 'clear') {
    const removed = forgetDecisions(m.store, project, { question: args.question, topic: args.topic })
    const text = forgotText(removed, where)
    return { text, data: { removed, text } }
  }
  return { text: 'design_decisions: action must be list, record or clear.', isError: true }
}

const USAGE = [
  'Usage: agent-mods design lists remembered decisions, agent-mods design clear forgets them.',
  '  agent-mods design [list] [--json]',
  '  agent-mods design clear [--question <q> | --topic <t>]',
  '  agent-mods design record --question <q> --choice <c> [--description <d>] [--topic <t>]',
  '  agent-mods design pick <questions.json> [--timeout 600] [--force] [--no-open] [--agent <name>]',
  '  agent-mods design gc',
  'Each takes --cwd <dir> (default: this folder); every worktree of a repo shares its decisions.',
].join('\n')

const flagText = (value) => (typeof value === 'string' ? value : undefined)

async function pickCli(c) {
  const file = c.positionals[1]
  if (!file) {
    c.error(USAGE)
    return 2
  }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8').replace(/^\uFEFF/, ''))
  } catch (err) {
    c.error(`design pick: could not read ${file}: ${err.message}`)
    return 2
  }
  const checked = validateQuestions(Array.isArray(raw) ? raw : raw?.questions)
  if (checked.error) {
    c.error(`design pick: ${checked.error}`)
    return 2
  }
  const timeout = Number(c.flags.timeout)
  const waitMs = (Number.isFinite(timeout) && timeout > 0 ? timeout : 600) * 1000
  const started = await startPick({
    store: c.store,
    project: c.project,
    questions: checked.questions,
    force: Boolean(c.flags.force),
    agent: agentFromName(flagText(c.flags.agent)),
    sessionKey: null,
    env: c.flags['no-open'] ? { ...c.env, AGENT_MODS_NO_BROWSER: '1' } : c.env,
    log: (message) => logError(c.store, `cli: ${message}`),
  })
  let result = started.done
  if (!result) {
    c.error(`Design picker: ${started.url}`)
    result = await awaitPick(c.store, c.project, started.pickId, waitMs)
    // Closing our own server ends the pick, so a late answer is not left for nobody to read.
    if (SERVERS.has(started.pickId)) {
      SERVERS.get(started.pickId).close()
      if (result.status === 'pending') result = await awaitPick(c.store, c.project, started.pickId, 0)
    }
  }
  c.printJson(result)
  return result.status === 'answered' || result.status === 'already_decided' ? 0 : 1
}

function designCli(c) {
  const sub = c.positionals[0] ?? 'list'
  const where = c.project.repoKey
  if (sub === 'list') {
    let decisions
    try {
      decisions = loadDecisions(c.store, c.project)
    } catch {
      c.error(READ_FAILED)
      return 1
    }
    const text = listText(decisions, where)
    if (c.json) c.printJson({ decisions, prompt: decisions.length ? decisionsPrompt(decisions) : '', text })
    else c.print(text)
    return 0
  }
  if (sub === 'clear') {
    c.print(forgotText(forgetDecisions(c.store, c.project, { question: flagText(c.flags.question), topic: flagText(c.flags.topic) }), where))
    return 0
  }
  if (sub === 'record') {
    const input = { question: flagText(c.flags.question), choice: flagText(c.flags.choice), description: flagText(c.flags.description), topic: flagText(c.flags.topic) }
    const { saved, error } = recordDecision(c.store, c.project, input, { at: c.now, agent: 'cli', sessionKey: null })
    if (error) {
      c.error(`design record: ${error}\n${USAGE}`)
      return 2
    }
    c.print(`Remembered for ${where}: ${decisionLine(saved)}`)
    return 0
  }
  if (sub === 'pick') return pickCli(c)
  if (sub === 'gc') {
    let removed = 0
    for (const entry of c.store.list('projects')) {
      if (entry.isDirectory()) removed += gcPicks(c.store, { projectId: entry.name }, c.now)
    }
    c.print(`Removed ${removed} design pick${removed === 1 ? '' : 's'}.`)
    return 0
  }
  c.error(USAGE)
  return 2
}

export default {
  name: 'design',
  hooks: {
    SessionStart(ctx) {
      const decisions = loadDecisions(ctx.store, ctx.project)
      if (decisions.length) ctx.out.context.push(decisionsPrompt(decisions))
      ctx.session.state('design').write({ cursor: newestAt(decisions) })
    },
    UserPromptSubmit(ctx) {
      const decisions = loadDecisions(ctx.store, ctx.project)
      if (!decisions.length) return
      const state = ctx.session.state('design')
      const seen = state.read(null)
      const newest = newestAt(decisions)
      if (typeof seen?.cursor !== 'number') {
        // No SessionStart reached this session (installed mid-session, or that hook failed): catch it up.
        ctx.out.context.push(decisionsPrompt(decisions))
      } else {
        if (newest <= seen.cursor) return
        const fresh = decisions.filter((d) => (Number(d.at) || 0) > seen.cursor && d.sessionKey !== ctx.session.key)
        if (fresh.length) ctx.out.context.push(`${NEW_DECISIONS}\n${fresh.map((d) => `- ${decisionLine(d)}`).join('\n')}`)
      }
      state.write({ cursor: newest })
    },
    SessionEnd(ctx) {
      gcPicks(ctx.store, ctx.project, ctx.now)
    },
  },
  briefing: (m, { project }) => {
    const decisions = loadDecisions(m.store, project)
    return decisions.length ? decisionsPrompt(decisions) : null
  },
  tools: [
    {
      name: 'design_pick',
      description:
        'Show the user design directions as rendered SVG mockups in a browser picker and return their pick; picks are remembered for the repo across agents. Give EVERY option an `svg`: one self-contained <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300"> drawing the real thing (colors, type, layout, sample copy, buttons), visibly different from the others, no scripts or external links, under ~8 KB. On status pending, give the user the url in one line and call again with pick_id.',
      inputSchema: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                question: { type: 'string' },
                header: { type: 'string', maxLength: 40 },
                topic: { type: 'string', description: 'palette, typography, layout, style, density, mood, component:<name>' },
                multiSelect: { type: 'boolean' },
                options: {
                  type: 'array',
                  minItems: 2,
                  maxItems: 6,
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', maxLength: 60 },
                      description: { type: 'string', maxLength: 200 },
                      svg: { type: 'string', description: 'SVG document, under 16 KB' },
                    },
                    required: ['label'],
                  },
                },
              },
              required: ['question', 'header', 'options'],
            },
          },
          pick_id: { type: 'string', description: 'Keep waiting on a pending pick' },
          wait_seconds: { type: 'integer', minimum: 0, maximum: 50, description: 'Default 40' },
          force: { type: 'boolean', description: 'Ask even if already decided' },
          cwd: { type: 'string' },
        },
      },
      run: designPickTool,
    },
    {
      name: 'design_decisions',
      description:
        "List, record or clear this repo's remembered design decisions (shared by every agent). list before UI work and follow what it returns; record when the user chose a direction in chat; clear forgets all, or one by question or topic (confirm with the user first).",
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'record', 'clear'] },
          question: { type: 'string' },
          choice: { type: 'string' },
          description: { type: 'string' },
          topic: { type: 'string' },
          cwd: { type: 'string' },
        },
        required: ['action'],
      },
      run: designDecisionsTool,
    },
  ],
  cli: [
    {
      name: 'design',
      aliases: ['design-decisions'],
      summary: 'Design decisions for this repo: list, clear, record, pick, gc',
      usage: USAGE,
      run: designCli,
    },
  ],
}
