// plain mod: plain-talk (basic-claude) for every agent, plus cross-agent finish alerts.
//
// Port of basic-claude hooks/register.tsx. One level and one list of known terms (plain.json) are
// shared by every agent and the CLI. The style rules go in as SessionStart context (the original
// added a prompt section on every turn) and the known-terms note as before: in full once per
// context, then as a delta on UserPromptSubmit. Not ported: the automatic haiku review and rewrite
// (no model calls on the hook path) and the band. The `plain` tool's review action hands the same
// rubric to the calling agent, which grades its own answer.
//
// Deliberate change: the level defaults to 'off' (the original: 'beginner'), because this user's
// rules forbid formulaic closing sections. `/plain expert` or `/plain beginner` turns it on.
import { DEFAULT_CONFIG, setConfigValue } from '../core/store.mjs'
import { agentLabel, clip, sanitize } from '../core/text.mjs'
import { DONE_WAV, launchNotifier } from './plain-notify.mjs'
import { LEVELS, REVIEW_SYSTEM, rulesFor } from './plain-rules.mjs'

const MOD = 'plain'
const FILE = 'plain.json'
const DEFAULT_LEVEL = 'off'
const MAX_TERMS = 300
const MAX_OFFERED = 6
const REWRITE_TAG = '[plain-talk]'
// Enough for the toast's 80-character clip; the full prompt lives in the agent's own transcript.
const MAX_ASK_CHARS = 200
// 300 terms of ordinary length fit; a pathological glossary must not crowd out other context.
const MAX_NOTE_CHARS = 4000

const objectOf = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

// Keep just the term: drop any "term: definition" tail, and anything phrase-length.
export const cleanTerm = (t) => {
  const term = t.split(':')[0].replace(/\s+/g, ' ').trim().toLowerCase()
  return term.length > 1 && term.split(' ').length <= 3 ? term : null
}
export const cleanTerms = (list) => [
  ...new Set(list.flatMap((t) => (typeof t === 'string' ? (cleanTerm(t) ?? []) : []))),
]

// Words about plain-talk itself, never offered as "I know this".
const META_TERMS = new Set([
  'plain-talk', 'plain talk', 'plain', 'plain words', 'plain english', 'plain language', 'jargon', 'technical term',
  'technical terms', 'known terms', 'i know this', 'done', 'not done', 'your next step', 'next step', 'chisle',
  'beginner', 'expert', 'reader level', 'rewrite', 'review',
])
export const isOfferable = (t) => !META_TERMS.has(t) && !t.includes('plain-talk') && t.length <= 40

// Old versions saved whole sentences; a list that cleaning changes is written back once.
const isTidy = (raw, terms) => terms.length === raw.length && terms.every((t, i) => t === raw[i])

// The terms that were new, and the list with them appended (oldest dropped past 300).
export function mergeTerms(known, list) {
  const added = cleanTerms(list).filter((t) => !known.includes(t))
  return { added, terms: [...known, ...added].slice(-MAX_TERMS) }
}

// "✓ plain" (with any style nits), or "✗ 2 problems: a; b", cut to fit one line.
export const gradeText = (g) => {
  if (g.pass) {
    const line = g.problems.length ? `✓ plain · nit: ${g.problems.join('; ')}` : '✓ plain'
    return line.length > 80 ? `${line.slice(0, 79)}…` : line
  }
  const n = g.problems.length
  const what = n ? `✗ ${n} problem${n === 1 ? '' : 's'}: ${g.problems.join('; ')}` : '✗ not plain'
  const line = what.length > 80 ? `${what.slice(0, 79)}…` : what
  return g.isFixing ? `${line} · rewriting` : line
}

// Lenient on purpose, like the original: a missing "pass" counts as a pass.
export const parseReview = (text) => {
  try {
    const r = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '')
    return {
      status: String(r.status ?? '').slice(0, 100),
      pass: r.pass !== false,
      problems: Array.isArray(r.problems) ? r.problems.map(String) : [],
      explained: Array.isArray(r.explained) ? cleanTerms(r.explained).filter(isOfferable) : [],
    }
  } catch {
    return null
  }
}

export const buildReviewPrompt = (level, known, ask, answer) => {
  const knownLine = known.length ? `\nTerms the reader already knows (not jargon): ${known.join(', ')}.` : ''
  return `Reader level: ${level}.${knownLine}\n\nThe user's request for this turn (if it asks for technical terms, detail or exact wording, giving that passes):\n<user_request>\n${ask || '(none)'}\n</user_request>\n\n<final_message>\n${answer}\n</final_message>`
}

export const rewriteText = (problems) =>
  `${REWRITE_TAG} Your last message may confuse the user: ${problems.join('; ') || 'not plain enough'}. Rewrite it as one complete final message that fixes only that, still giving everything the user asked for. Do not run any tools.`

// The terms come from the shared store, which any agent can write, so the note is sanitized.
export const knownTermsNote = (terms) =>
  sanitize(`plain-talk: the user already understands these terms, so use them without re-explaining: ${terms.join(', ')}`, MAX_NOTE_CHARS)

// The original re-read the level on every turn. Here the rules arrive once per context, so a level
// changed mid-session is applied by fetching the rules again, and 'off' has to say to drop them.
const OFF_NOTE = 'plain-talk is off: no plain-talk style rules apply. If plain-talk rules were given earlier in this session, stop following them.'

export function rulesText(level, terms) {
  if (level === 'off') return OFF_NOTE
  return level === 'beginner' && terms.length ? `${rulesFor(level)}\n\n${knownTermsNote(terms)}` : rulesFor(level)
}

// /plain arguments, exactly as register.tsx command.run reads them.
export function parsePlainArgs(text) {
  const arg = String(text ?? '').trim()
  const [word = '', ...rest] = arg.split(/\s+/)
  const cmd = word.toLowerCase()
  if (cmd === 'forget') return { action: 'forget' }
  if (cmd === 'know') return { action: 'know', terms: cleanTerms(rest.join(' ').split(',')) }
  if (LEVELS.includes(cmd) && !rest.length) return { action: 'level', level: cmd }
  return { action: 'status' }
}

// Settings: plain.json = { level, terms }. Every write is a locked read-modify-write, because four
// agents and the CLI share one glossary.
export function readSettings(store) {
  const raw = objectOf(store.readJson(FILE, null))
  const terms = Array.isArray(raw.terms) ? cleanTerms(raw.terms) : []
  if (Array.isArray(raw.terms) && !isTidy(raw.terms, terms)) {
    // Recomputed under the lock, so a `know` from another agent in between is kept. A failed write
    // only delays the tidy-up; the cleaned list is still what this read returns.
    try {
      store.update(FILE, {}, (current) => {
        const list = objectOf(current).terms
        if (!Array.isArray(list)) return undefined
        const tidy = cleanTerms(list)
        return isTidy(list, tidy) ? undefined : { ...objectOf(current), terms: tidy }
      })
    } catch {}
  }
  return { level: LEVELS.includes(raw.level) ? raw.level : DEFAULT_LEVEL, terms }
}

const writeSettings = (store, fn) => store.update(FILE, {}, (current) => fn(objectOf(current)))

function addTerms(store, list) {
  let added = []
  writeSettings(store, (current) => {
    const raw = Array.isArray(current.terms) ? current.terms : []
    const known = cleanTerms(raw)
    const merged = mergeTerms(known, list)
    added = merged.added
    return added.length || !isTidy(raw, known) ? { ...current, terms: merged.terms } : undefined
  })
  return added
}

const USAGE =
  'Use /plain beginner, /plain expert, /plain off, /plain know <term> (comma-separate several; no term lists them), or /plain forget to clear the term list.'

// One parsed /plain command -> { text, data }. Shared by the MCP tool and the CLI; the reply texts
// are the original's.
export function runPlainCommand(store, cmd) {
  if (cmd.action === 'forget') {
    writeSettings(store, (current) => ({ ...current, terms: [] }))
    return { text: 'plain-talk forgot every term you knew.', data: { terms: [] } }
  }
  if (cmd.action === 'know') {
    if (!cmd.terms.length) {
      const { terms } = readSettings(store)
      return {
        text: terms.length ? `Terms you know: ${terms.join(', ')}` : 'You have not marked any terms as known yet. Use /plain know <term>.',
        data: { terms },
      }
    }
    const added = addTerms(store, cmd.terms)
    return {
      text: added.length ? `plain-talk will treat these as known: ${added.join(', ')}` : 'plain-talk already knew those terms.',
      data: { added },
    }
  }
  if (cmd.action === 'level') {
    writeSettings(store, (current) => ({ ...current, level: cmd.level }))
    return { text: `plain-talk is now: ${cmd.level}`, data: { level: cmd.level } }
  }
  const { level, terms } = readSettings(store)
  return { text: `plain-talk level: ${level}. Terms you know: ${terms.length}.\n${USAGE}`, data: { level, termsCount: terms.length } }
}

// --- hooks -------------------------------------------------------------------------------------

const toldMark = (terms) => ({ told: terms.length, toldLast: terms.length ? terms[terms.length - 1] : null })

// Terms this session's context has not been told yet. The original kept only a count; a count goes
// wrong once the list is rewritten under a live session (forget or the 300-term cap, from any
// agent or the CLI), so the last term told is kept too and a mismatch tells the whole list again.
export function untoldTerms(terms, state) {
  const s = objectOf(state)
  let count = Number.isInteger(s.told) && s.told > 0 ? s.told : 0
  if (count > terms.length || (count && terms[count - 1] !== s.toldLast)) count = 0
  return terms.slice(count)
}

function sessionStart(ctx) {
  if (ctx.ev.isSubagent) return
  const { level, terms } = readSettings(ctx.store)
  if (level !== 'off') ctx.out.context.push(rulesText(level, terms))
  // A new, resumed or compacted context knows only what this event tells it.
  const told = level === 'beginner' ? terms : []
  const state = ctx.session.state(MOD)
  if (told.length || objectOf(state.read({})).told) state.update((current) => ({ ...objectOf(current), ...toldMark(told) }), {})
}

function userPromptSubmit(ctx) {
  const { ev, now } = ctx
  if (ev.isSubagent) return
  const { level, terms } = readSettings(ctx.store)
  const ask = typeof ev.prompt === 'string' ? ev.prompt : ''
  let fresh = []
  ctx.session.state(MOD).update((current) => {
    const s = objectOf(current)
    fresh = level === 'beginner' ? untoldTerms(terms, s) : []
    return {
      ...s,
      // A turn with no typed prompt (a continuation) keeps the user's last request.
      ...(ask.trim() ? { lastAsk: clip(sanitize(ask), MAX_ASK_CHARS) } : {}),
      turnStartedAt: now,
      ...(fresh.length ? toldMark(terms) : {}),
    }
  }, {})
  if (fresh.length) ctx.out.context.push(knownTermsNote(fresh))
}

// config.notify, with a hand-edited bad afterMs falling back to the default.
export function notifySettings(config) {
  const n = objectOf(config?.notify)
  const afterMs = Number(n.afterMs)
  return {
    enabled: n.enabled === true,
    afterMs: Number.isFinite(afterMs) && afterMs >= 0 ? afterMs : DEFAULT_CONFIG.notify.afterMs,
    sound: n.sound !== false,
  }
}

function stop(ctx, launch) {
  const { ev, now } = ctx
  const notify = notifySettings(ctx.config)
  // A block from an earlier mod means the agent keeps working: this is not the end of the turn.
  if (!notify.enabled || ev.isSubagent || ev.attended === false || ctx.out.block) return
  const state = ctx.session.state(MOD)
  const s = objectOf(state.read({}))
  const started = s.turnStartedAt
  if (!Number.isFinite(started) || now - started <= notify.afterMs || s.alertedFor === started) return
  // One alert per user turn: a Stop hook that blocks makes the agent stop again later.
  state.update((current) => ({ ...objectOf(current), alertedFor: started }), {})
  const ask = s.lastAsk ? clip(s.lastAsk, 80) : ''
  launch({
    title: `${agentLabel(ev.agent)} finished and needs you`,
    message: ask ? `${ctx.project.name}: ${ask}` : ctx.project.name,
    sound: notify.sound ? DONE_WAV : null,
  })
}

// --- MCP tool ----------------------------------------------------------------------------------

const termList = (terms) =>
  Array.isArray(terms) ? terms.flatMap((t) => String(t).split(',')) : String(terms ?? '').split(',')

function reviewRubric(level, known, request, answer) {
  return [
    'Grade your own final message with this rubric: you are the reviewer, no other model is called.',
    '',
    '<rubric>',
    REVIEW_SYSTEM,
    '</rubric>',
    '',
    buildReviewPrompt(level, known, request, answer),
    '',
    "Then call the agent-mods `plain` tool again with action \"review\" and `grade` set to your JSON (CLI: agent-mods plain review --grade '<json>'). It returns the grade line to show the user.",
  ].join('\n')
}

function gradeReply(level, known, grade) {
  const review = parseReview(typeof grade === 'string' ? grade : JSON.stringify(grade))
  if (!review) return { text: 'That grade is not the JSON the rubric asks for: {"status", "pass", "problems", "explained"}.', isError: true }
  const offered = level === 'beginner' ? [...new Set(review.explained)].filter((t) => !known.includes(t)).slice(0, MAX_OFFERED) : []
  // The user asked for this review, so a failed answer is rewritten once now.
  const line = gradeText({ pass: review.pass, problems: review.problems, offered, isFixing: !review.pass })
  const lines = [review.status ? `◆ ${review.status}  ${line}` : line]
  if (offered.length) lines.push(`I know this: ${offered.join(', ')} (say "/plain know <term>" to stop explanations of a term)`)
  if (!review.pass) lines.push(rewriteText(review.problems))
  return { text: lines.join('\n'), data: { ...review, offered, gradeText: line } }
}

// rules and review read the level from the call when it is a valid one, else from plain.json.
function levelFor(requested, settings) {
  return LEVELS.includes(requested) ? requested : settings.level
}

export function rulesReply(store, requested) {
  const settings = readSettings(store)
  const level = levelFor(requested, settings)
  return { text: rulesText(level, settings.terms), data: { level } }
}

export function reviewReply(store, { level: requested, request, answer, grade } = {}) {
  const settings = readSettings(store)
  const level = levelFor(requested, settings)
  if (level === 'off') {
    return { text: 'plain-talk is off, so there is nothing to review against. Turn it on with /plain beginner or /plain expert.', data: { level } }
  }
  if (grade !== undefined && grade !== null && grade !== '') return gradeReply(level, settings.terms, grade)
  if (typeof answer !== 'string' || !answer.trim()) {
    return { text: "review needs `answer` (your final message) and `request` (the user's request), or `grade` (your JSON grade).", isError: true }
  }
  return { text: reviewRubric(level, settings.terms, typeof request === 'string' ? request : '', answer), data: { level } }
}

const plainTool = {
  name: 'plain',
  description:
    'plain-talk answer style shared by every agent. status; level (beginner|expert|off, then call rules to apply it now); know (comma-separated terms the user knows; none lists them); forget; rules (the style rules for this session); review (request + answer returns a rubric to grade your own final message, then call again with grade).',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'level', 'know', 'forget', 'rules', 'review'] },
      level: { type: 'string', enum: LEVELS },
      terms: { type: 'string', description: 'know: comma-separated terms (a list also works)' },
      request: { type: 'string', description: "review: the user's request for the turn" },
      answer: { type: 'string', description: 'review: your final message' },
      grade: { type: 'string', description: 'review: your JSON grade from the rubric' },
    },
    required: ['action'],
  },
  run(args, mctx) {
    const a = objectOf(args)
    const action = String(a.action ?? 'status').toLowerCase()
    const store = mctx.store
    if (action === 'status' || action === 'forget') return runPlainCommand(store, { action })
    if (action === 'know') return runPlainCommand(store, { action, terms: cleanTerms(termList(a.terms)) })
    if (action === 'level') {
      const level = String(a.level ?? '').toLowerCase()
      if (!LEVELS.includes(level)) return { text: 'level must be beginner, expert or off.', isError: true }
      return runPlainCommand(store, { action, level })
    }
    if (action === 'rules') return rulesReply(store, a.level)
    if (action === 'review') return reviewReply(store, a)
    return { text: `Unknown action: ${action}. Use status, level, know, forget, rules or review.`, isError: true }
  },
}

// --- CLI ---------------------------------------------------------------------------------------

// `rules` and `review` are the skill's shell fallback for the tool actions of the same name; every
// other argument goes through the /plain parser unchanged.
const plainCli = {
  name: 'plain',
  summary: 'plain-talk level and known terms: status, beginner, expert, off, know [terms], forget, rules, review',
  usage: [
    'agent-mods plain [status | beginner | expert | off | know [<term>[, <term>...]] | forget] [--json]',
    'agent-mods plain rules [beginner | expert | off]',
    "agent-mods plain review --request <text> --answer <text>   then   agent-mods plain review --grade '<json>'",
  ].join('\n'),
  run(c) {
    const [first, second] = c.positionals
    let result
    if (first === 'rules') result = rulesReply(c.store, second)
    else if (first === 'review') {
      const { level, request, answer, grade } = c.flags
      result = reviewReply(c.store, { level, request, answer, grade })
    } else result = runPlainCommand(c.store, parsePlainArgs(c.positionals.join(' ')))
    if (result.isError) {
      c.error(result.text)
      return 2
    }
    if (c.json) c.printJson(result.data)
    else c.print(result.text)
    return 0
  },
}

const NOTIFY_USAGE =
  'agent-mods notify [status | on | off | test | after <seconds>]  (sound: agent-mods config set notify.sound false)'

const seconds = (ms) => Number((ms / 1000).toFixed(1))

function notifyStatus(n, platform) {
  const what = `a toast${n.sound ? ' and a sound' : ''} when an agent turn longer than ${seconds(n.afterMs)} s ends`
  const line = n.enabled ? `Finish alerts are on: ${what}.` : `Finish alerts are off. When on: ${what}.`
  return platform === 'win32' ? line : `${line} (Windows only: nothing shows on this system.)`
}

function notifyCli(launch, platform) {
  return {
    name: 'notify',
    summary: 'Finish alerts (toast and sound when a long agent turn ends): status, on, off, test, after <seconds>',
    usage: NOTIFY_USAGE,
    run(c) {
      const [sub = 'status', value] = c.positionals
      const current = notifySettings(c.config)
      const show = (n) => {
        if (c.json) c.printJson(n)
        else c.print(notifyStatus(n, platform))
        return 0
      }
      if (sub === 'status') return show(current)
      if (sub === 'on' || sub === 'off') {
        setConfigValue(c.store, 'notify.enabled', sub === 'on')
        return show({ ...current, enabled: sub === 'on' })
      }
      if (sub === 'after') {
        const secs = Number(value)
        if (!String(value ?? '').trim() || !Number.isFinite(secs) || secs < 0) {
          c.error(`Usage: ${NOTIFY_USAGE}`)
          return 2
        }
        const afterMs = Math.round(secs * 1000)
        setConfigValue(c.store, 'notify.afterMs', afterMs)
        return show({ ...current, afterMs })
      }
      if (sub === 'test') {
        const sent = launch({
          title: 'agent-mods test alert',
          message: `This is how a finished turn is announced (${c.project.name}).`,
          sound: current.sound ? DONE_WAV : null,
        })
        if (!sent) {
          c.error(platform === 'win32' ? 'Could not start the notifier (node or powershell.exe failed to launch).' : 'Finish alerts work on Windows only; nothing was sent.')
          return 1
        }
        c.print(`Sent a test alert (toast${current.sound ? ' and sound' : ''}). If no toast appeared, check that Windows notifications are on for Windows PowerShell.`)
        return 0
      }
      c.error(`Usage: ${NOTIFY_USAGE}`)
      return 2
    },
  }
}

// spawner/platform are injectable so tests can check the notifier command without running it.
export function createPlain({ spawner, platform } = {}) {
  const launch = (alert) => launchNotifier(alert, { spawner, platform })
  return {
    name: MOD,
    hooks: {
      SessionStart: sessionStart,
      UserPromptSubmit: userPromptSubmit,
      Stop: (ctx) => stop(ctx, launch),
    },
    tools: [plainTool],
    cli: [plainCli, notifyCli(launch, platform ?? process.platform)],
    briefing: (m) => {
      const { level, terms } = readSettings(m.store)
      return level === 'off' ? null : rulesText(level, terms)
    },
  }
}

export default createPlain()
