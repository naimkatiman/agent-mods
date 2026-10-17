// clawd mod: Clawd, the pixel-art companion from claude-mods clawd-pet, for every agent.
//
// The original drew inside Claude Code's prompt band, which no other agent offers. So the hooks here
// only append one small line per event to events/YYYY-MM-DD.jsonl, and the user runs the renderer
// (`agent-mods clawd watch`, clawd-watch.mjs) in a terminal pane of their own: one pet per live
// session of any agent. /clawd is a skill backed by the `clawd` MCP tool, with the CLI as fallback.
//
// Store:
//   clawd.json                      { hat: pinned name|null, shades, hidden, lastGc }  (global)
//   sessions/<key>/clawd.json       { hat }  the hat this session's Clawd wears
//   events/YYYY-MM-DD.jsonl         { v, t, agent, sid, pk, project, ev, kind?, label?, ok?, ... }
// Event lines never carry prompt text or commands: an edit's file name is the most they say.
import { clip } from '../core/text.mjs'
import { sessionState } from '../core/store.mjs'
import { resolveCallerSession } from '../core/session-records.mjs'
import {
  MAX_W,
  MOODS,
  WEARABLE,
  base,
  clawdCommand,
  frame,
  newPet,
  randomHat,
  step,
  toAnsi,
  validHat,
} from './clawd-sprite.mjs'

export const EVENT_VERSION = 1
export const EVENTS_DIR = 'events'
export const PREFS_FILE = 'clawd.json'
const DAY_MS = 24 * 3_600_000
const KEEP_DAYS = 3
const MAX_LINE_BYTES = 1024
const NAME_MAX = 48
const VERBS = ['status', 'hat', 'hats', 'pet', 'dance', 'party', 'shades', 'hide', 'show']
const SESSION_KEY = /^[A-Za-z0-9._-]+__[A-Za-z0-9._-]+$/

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// Local date, so a day's file matches the user's day rather than UTC's.
export function localDate(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function eventRel(ms) {
  return `${EVENTS_DIR}/${localDate(ms)}.jsonl`
}

function prefsOf(raw) {
  const prefs = isObject(raw) ? raw : {}
  return {
    hat: validHat(prefs.hat),
    shades: prefs.shades === true,
    hidden: prefs.hidden === true,
    lastGc: Number.isFinite(prefs.lastGc) ? prefs.lastGc : 0,
  }
}

export function readPrefs(store) {
  return prefsOf(store.readJson(PREFS_FILE, {}))
}

// The hat a session's Clawd wears, or null. Keys come from event lines in the renderer, so anything
// that is not a plain session key never reaches the file system.
export function sessionHat(store, key) {
  if (typeof key !== 'string' || !SESSION_KEY.test(key)) return null
  const saved = sessionState(store, key, 'clawd').read({})
  return validHat(isObject(saved) ? saved.hat : null)
}

function saveSessionHat(store, key, hat) {
  sessionState(store, key, 'clawd').update((current) => ({ ...(isObject(current) ? current : {}), hat }), {})
}

// One append, one line, always under 1 KB: concurrent appenders from four agents interleave whole
// lines, and the renderer skips anything it cannot parse.
export function appendEvent(store, line) {
  const out = { ...line }
  for (const key of ['label', 'arg', 'project']) {
    if (Buffer.byteLength(JSON.stringify(out)) < MAX_LINE_BYTES) break
    delete out[key]
  }
  if (Buffer.byteLength(JSON.stringify(out)) >= MAX_LINE_BYTES) return
  store.append(eventRel(out.t), out)
}

// Event files older than KEEP_DAYS go, at most once a day: the lastGc stamp in clawd.json is taken
// under its lock, so only one hook process of all the agents does the sweep.
export function gcEvents(store, now) {
  let due = false
  store.update(PREFS_FILE, {}, (current) => {
    const prefs = isObject(current) ? current : {}
    if (now - (Number(prefs.lastGc) || 0) < DAY_MS) return undefined
    due = true
    return { ...prefs, lastGc: now }
  })
  if (!due) return 0
  const cutoff = localDate(now - KEEP_DAYS * DAY_MS)
  let removed = 0
  for (const entry of store.list(EVENTS_DIR)) {
    const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(entry.name)
    if (!entry.isFile() || !match || match[1] >= cutoff) continue
    store.remove(`${EVENTS_DIR}/${entry.name}`)
    removed++
  }
  return removed
}

function hookLine(ctx, ev) {
  return {
    v: EVENT_VERSION,
    t: ctx.now,
    agent: ctx.ev.agent,
    sid: ctx.session.key,
    pk: ctx.project.projectId,
    project: clip(ctx.project.name, NAME_MAX),
    ev,
  }
}

// A session's Clawd wears the pinned hat, else keeps the hat it already has (resume, compact),
// else gets a random one, as the original did at session.start.
function sessionStart(ctx) {
  const prefs = readPrefs(ctx.store)
  let hat = null
  ctx.session.state('clawd').update((current) => {
    const saved = isObject(current) ? current : {}
    const had = validHat(saved.hat)
    hat = prefs.hat ?? had ?? randomHat()
    return hat === had ? undefined : { ...saved, hat }
  }, {})
  appendEvent(ctx.store, { ...hookLine(ctx, 'session.start'), hat })
  if (ctx.now - prefs.lastGc >= DAY_MS) gcEvents(ctx.store, ctx.now)
}

function postToolUse(ctx) {
  // The original ignored subagents' tool calls (register.tsx:381).
  if (ctx.ev.isSubagent) return
  const line = hookLine(ctx, 'tool.post')
  if (ctx.ev.toolKind) line.kind = ctx.ev.toolKind
  const file = ctx.ev.toolKind === 'edit' ? ctx.ev.edits[0]?.path : null
  if (file) line.label = clip(base(file), NAME_MAX)
  line.ok = !ctx.ev.toolFailed
  appendEvent(ctx.store, line)
}

function stop(ctx) {
  // Another mod asking the agent to continue (ctx.out.block) means the turn is not over yet.
  if (ctx.ev.isSubagent || ctx.out.block) return
  appendEvent(ctx.store, hookLine(ctx, 'turn.stop'))
}

// Runs one /clawd command: reply text, saved prefs and session hat, and a clawd.cmd line so a
// running renderer plays it. `target` is the calling session ({ agent, key }) or null, in which
// case every Clawd on screen plays it.
export function runCommand({ store, now, project, target, agent = null, input, rand = Math.random }) {
  const savedHat = target ? sessionHat(store, target.key) : null
  let result
  // Decided inside the prefs lock: two agents toggling shades at once still toggle twice.
  store.update(PREFS_FILE, {}, (current) => {
    const prefs = prefsOf(current)
    const look = { hat: savedHat ?? prefs.hat ?? randomHat(rand), shades: prefs.shades, hidden: prefs.hidden, pinned: prefs.hat }
    result = clawdCommand(clip(String(input ?? ''), 200), look, rand)
    const { next } = result
    if (next.pinned === prefs.hat && next.shades === prefs.shades && next.hidden === prefs.hidden) return undefined
    return { ...(isObject(current) ? current : {}), hat: next.pinned, shades: next.shades, hidden: next.hidden }
  })
  const { next } = result
  if (target && next.hat !== savedHat) saveSessionHat(store, target.key, next.hat)

  const line = {
    v: EVENT_VERSION,
    t: now,
    agent: target?.agent ?? agent ?? null,
    sid: target?.key ?? null,
    pk: project.projectId,
    project: clip(project.name, NAME_MAX),
    ev: 'clawd.cmd',
    verb: clip(result.verb, 20),
    arg: clip(result.arg, NAME_MAX),
  }
  if (!result.ok) line.ok = false
  // A targeted command also tells the renderer which hat that session wears, so the pane and the
  // reply agree even when the pet was drawn before its hat was known.
  if (target || (result.verb === 'hat' && result.ok)) line.hat = next.hat
  if (result.verb === 'shades') line.shades = next.shades
  if (result.verb === 'hide' || result.verb === 'show') line.hidden = next.hidden
  appendEvent(store, line)

  return {
    text: result.text,
    data: {
      verb: result.verb || 'status',
      hat: next.hat,
      prefs: { hat: next.pinned, shades: next.shades, hidden: next.hidden },
      session: target?.key ?? null,
    },
  }
}

function callerOf(fn) {
  try {
    return fn() ?? null
  } catch {
    return null
  }
}

// The CLI has no MCP client to name the agent; an agent's shell still carries its session id.
function cliTarget(c) {
  return callerOf(() => resolveCallerSession(c.store, { agent: c.agent, env: c.env ?? {}, project: c.project, now: c.now }))
}

const flagOn = (value) => value !== undefined && !['false', '0', 'no', 'off'].includes(String(value).toLowerCase())

function printFrame(c) {
  const mood = c.flags.mood === undefined ? 'idle' : String(c.flags.mood).toLowerCase()
  if (!MOODS.includes(mood)) {
    c.error(`Unknown mood "${mood}". Moods: ${MOODS.join(', ')}`)
    return 2
  }
  const hat = c.flags.hat === undefined ? 'tophat' : String(c.flags.hat).toLowerCase()
  if (!validHat(hat)) {
    c.error(`No hat called "${hat}". Hats: ${WEARABLE.join(', ')}`)
    return 2
  }
  // Tick 0 of idle is a blink (eyes shut, so no shades); two ticks in, the eyes are open.
  const ticks = c.flags.ticks === undefined ? 2 : Number(c.flags.ticks)
  if (!Number.isInteger(ticks) || ticks < 0 || ticks > 100_000) {
    c.error('--ticks takes a whole number from 0 to 100000')
    return 2
  }
  const pet = newPet({ mood, hat, shades: flagOn(c.flags.shades), width: MAX_W })
  for (let i = 0; i < ticks; i++) step(pet)
  c.print(toAnsi(frame(pet)))
  return 0
}

// Which sessions the pane shows: --all, else the --project folder's project, else this folder's
// project when it is in a repo. Anywhere else (a home folder) it shows every project.
export function paneScope({ flags, project }) {
  const scoped = !flags.all && (flags.project !== undefined || project.isRepo)
  return scoped ? { filter: project.projectId, scope: project.name } : { filter: null, scope: 'all projects' }
}

async function watchPane(c) {
  const { watch } = await import('./clawd-watch.mjs')
  return watch({ store: c.store, ...paneScope(c) })
}

const USAGE = [
  'agent-mods clawd [status | hat [name|random] | hats | pet | dance | party | shades | hide | show]',
  'agent-mods clawd watch [--all | --project <dir>]    the live pane: one Clawd per agent session (ctrl+c quits)',
  'agent-mods clawd frame [--mood idle|work|party|dance|sleep] [--hat <name>] [--shades] [--ticks n (default 2)]',
].join('\n')

export default {
  name: 'clawd',
  hooks: {
    SessionStart: sessionStart,
    UserPromptSubmit(ctx) {
      if (!ctx.ev.isSubagent) appendEvent(ctx.store, hookLine(ctx, 'prompt.submit'))
    },
    PostToolUse: postToolUse,
    Stop: stop,
    // A turn that ended in an error (Claude) or was aborted (Codex) is over too.
    StopFailure: stop,
    Interrupt: stop,
    Notification(ctx) {
      appendEvent(ctx.store, hookLine(ctx, 'notify'))
    },
    SessionEnd(ctx) {
      appendEvent(ctx.store, hookLine(ctx, 'session.end'))
    },
  },
  tools: [
    {
      name: 'clawd',
      description:
        'Clawd, the pixel-art pet shown by `agent-mods clawd watch`. Only for /clawd requests: change or list hats, pet, dance, party, shades, hide, show, status. Reply with the returned text exactly.',
      inputSchema: {
        type: 'object',
        properties: {
          verb: { type: 'string', enum: VERBS },
          arg: { type: 'string', description: 'hat only: a hat name, or random' },
          cwd: { type: 'string', description: 'Your working directory' },
        },
        required: ['verb'],
      },
      run(args, m) {
        const project = m.project(typeof args.cwd === 'string' ? args.cwd : undefined)
        const target = callerOf(() => m.caller(args, project))
        return runCommand({
          store: m.store,
          now: m.now,
          project,
          target,
          agent: m.agent,
          input: `${args.verb ?? ''} ${args.arg ?? ''}`,
        })
      },
    },
  ],
  cli: [
    {
      name: 'clawd',
      summary: 'Clawd the pixel pet: hats, pet, dance, party, shades, hide/show; `clawd watch` draws every session',
      usage: USAGE,
      async run(c) {
        const [verb = ''] = c.positionals
        if (verb === 'watch') return watchPane(c)
        if (verb === 'frame') return printFrame(c)
        const result = runCommand({
          store: c.store,
          now: c.now,
          project: c.project,
          target: cliTarget(c),
          input: c.positionals.join(' '),
        })
        if (c.json) c.printJson({ text: result.text, ...result.data })
        else c.print(result.text)
        return 0
      },
    },
  ],
}
