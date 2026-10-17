// The dashboard's snapshot: every agent session on this machine (the monitor's rows, each joined to
// its record), the files two live sessions both edited, the projects that have something to show,
// the shared settings and a few health signals, as one plain object the page renders. Every part
// comes from the function the CLI and the MCP tools use for it, so the page cannot disagree with
// `agent-mods monitor`, `idea list`, `assumptions list` or `design list`.
//
// Pure reads: no locks, no process spawns, nothing written, renamed or deleted. That rules out
// takeInbox (it deletes expired messages, peek or not), plain's readSettings (it can rewrite
// plain.json) and anything that delivers. The one write is logError when a part fails, once per
// distinct failure, because this runs every 2 s.
//
// Reads: sessions/*.json, sessions/<key>/inbox/ and sessions/<key>/clawd.json, the agents' own
// registries (through listSessions), projects/<id>/{meta,ideas,assumptions,design}.json,
// config.json, plain.json, clawd.json and logs/errors.log. Owns no file.
import fs from 'node:fs'
import path from 'node:path'
import { sha1 } from '../core/fsx.mjs'
import { projectInfo } from '../core/project.mjs'
import { listRecords } from '../core/session-records.mjs'
import { DEFAULT_CONFIG, loadConfig, logError, projectFile, sessionKey } from '../core/store.mjs'
import { agentLabel, sanitize } from '../core/text.mjs'
import { FILE as ASSUMPTIONS_FILE, STATUS, normalizeDoc } from '../mods/assumptions-logic.mjs'
import { readPrefs, sessionHat } from '../mods/clawd.mjs'
import { loadDecisions } from '../mods/design.mjs'
import { ordered, publicIdea, readShelf } from '../mods/ideas-shelf.mjs'
import { cleanTerms, notifySettings } from '../mods/plain.mjs'
import { LEVELS } from '../mods/plain-rules.mjs'
import { INBOX_TTL_MS, fileClashes, inboxDir, listSessions } from '../mods/sessions-data.mjs'
import { canResume, label, nameOf, peerText } from '../mods/sessions-text.mjs'

export const SNAPSHOT_VERSION = 1
// The shapes the dashboard trusts before a value reaches a store path. A session key is what
// sessionKey() makes: no '/' or '\', and the '__' inside means it is never '.' or '..'. A project
// id ends in its hash, so it never ends in a dot (Windows drops trailing dots from a path segment).
export const SESSION_KEY = /^[A-Za-z0-9._-]+__[A-Za-z0-9._-]+$/
export const SESSION_KEY_MAX = 200
export const PROJECT_ID = /^[A-Za-z0-9._-]{0,119}[A-Za-z0-9]$/
export const PROJECT_ID_MAX = 120

const HEALTH_AGENTS = ['claude', 'codex', 'grok', 'devin']
// `monitor watch` lists this many; the page shows them all.
const SESSIONS_MAX = 200
const ENDED_SHOWN_MS = 24 * 3_600_000
const ENDED_MAX = 30
const TASKS_SHOWN = 10
const ASSUMPTIONS_SHOWN = 100
// The rest of the lists the page draws are capped the same way, newest kept: every session heartbeat
// pushes the whole snapshot to every page, so no part may grow with the store.
const CLASHES_SHOWN = 20
const IDEAS_SHOWN = 50
const RULES_SHOWN = 50
const DECISIONS_SHOWN = 50
const ERROR_TEXT_MAX = 200
// Caps that real ids and paths never reach: the resume route rebuilds commands from these values.
const ID_MAX = 500
const PATH_MAX = 4096
const TASK_STATUS = new Set(['pending', 'in_progress', 'completed'])
// plain.mjs reads a missing plain.json, or a level it does not know, as off.
const PLAIN_OFF = 'off'
// logError writes `${ISO} ${message}`; the lines after it (a stack trace) belong to that entry.
const ENTRY_START = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) /
const NO_ERRORS = { count: 0, lastAt: null, last: null }

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const num = (value) => (Number.isFinite(value) ? value : null)
const textOrNull = (value, max) => (typeof value === 'string' && value ? peerText(value, max) : null)
// Paths keep their spacing (peerText would fold a double space): only control characters go.
const pathOrNull = (value) => (typeof value === 'string' && value ? sanitize(value, PATH_MAX) : null)

// A part that throws (a corrupt record, a file another process holds) leaves only that part empty.
// The failure is logged once until it changes or the part recovers: this runs every 2 s.
const logged = new Map()

function guard(store, part, fn, fallback) {
  const slot = `${store.root}|${part}`
  try {
    const value = fn()
    logged.delete(slot)
    return value
  } catch (err) {
    const message = `dashboard: snapshot ${part}: ${err?.stack ?? err}`
    if (logged.get(slot) !== message) {
      logged.set(slot, message)
      logError(store, message)
    }
    return fallback
  }
}

// A build reads every session record three times (listSessions, fileClashes, the join here), and on
// this host opening one small store file costs 0.5-1.2 ms against 0.015 ms for a stat: 580 records
// took 1.5-2.4 s a build (measured 2026-10-12; 40 ms with this cache). So each store JSON file is
// parsed again only when its mtime:size:inode stamp moves, which every store write does (a temp file
// renamed over the old one, or failing that a rewrite in place), and a file this build has already
// read is not even stat'd again (1,894 stats a warm build for 580 records, three per record).
//
// A file that does not parse is remembered under its stamp too: readJson sleeps 15 ms (31 on this
// host) before its retry, and an empty or garbled record (an unclean shutdown) is never pruned, so it
// cost three sleeps a build for good. A writer finishing a half-written file moves its stamp, so it is
// read again exactly then. A read that throws is remembered for the rest of its build only: a file
// another process holds reads as EBUSY or EPERM, and its stamp does not move when that process lets
// go, so remembering it longer would hide a live session until its next write.
//
// The cache holds exactly the files the last build read. Agent registries and lock files are not
// store reads, so liveness is still probed fresh on every build.
const readCaches = new Map()
// The fallback this cache asks readJson for, so a file that does not parse is told apart from one
// that holds the caller's fallback value.
const UNPARSED = Symbol('unparsed')

function cachedReads(store) {
  const previous = readCaches.get(store.root) ?? new Map()
  const next = new Map()
  const failed = new Map()
  const readJson = (rel, fallback = null) => {
    const file = path.isAbsolute(rel) ? rel : store.path(rel)
    if (failed.has(file)) throw failed.get(file)
    let entry = next.get(file)
    if (!entry) {
      let stamp
      try {
        const stat = fs.statSync(file)
        stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`
      } catch {
        return store.readJson(rel, fallback)
      }
      entry = previous.get(file)
      if (entry?.stamp !== stamp) {
        let value
        try {
          value = store.readJson(rel, UNPARSED)
        } catch (err) {
          failed.set(file, err)
          throw err
        }
        entry = value === UNPARSED ? { stamp, unparsed: true } : { stamp, value }
      }
      next.set(file, entry)
    }
    return entry.unparsed ? fallback : entry.value
  }
  return { store: { ...store, readJson }, keep: () => readCaches.set(store.root, next) }
}

// --- sessions -------------------------------------------------------------------------------------

function lastEdit(edits) {
  if (!isObject(edits)) return null
  const times = Object.values(edits).filter((at) => Number.isFinite(at))
  return times.length ? Math.max(...times) : null
}

// What takeInbox would still deliver: its file filter and its 24 h expiry, counted without taking,
// peeking or deleting anything.
function unreadCount(store, key, now) {
  let entries = []
  try {
    entries = fs.readdirSync(inboxDir(store, key), { withFileTypes: true })
  } catch {
    return 0
  }
  return entries.filter((e) => {
    if (!e.isFile() || !e.name.endsWith('.json') || e.name.includes('.tmp.')) return false
    const stamp = Number(e.name.split('-')[0])
    return now - (Number.isFinite(stamp) ? stamp : 0) <= INBOX_TTL_MS
  }).length
}

// A native-only row has no record to name its project; its registry cwd maps the way a hook's would.
function cwdProjectId(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null
  try {
    return projectInfo(cwd).projectId
  } catch {
    return null
  }
}

// readJson rethrows anything but a missing file (EBUSY or EPERM from another process, a damaged
// store). One hat that cannot be read leaves its own row hatless instead of emptying the whole
// sessions part, and with it every count and live total.
function hatOf(store, key) {
  try {
    return sessionHat(store, key)
  } catch {
    return null
  }
}

function sessionOf(store, row, record, now) {
  const key = sessionKey(row.agent, row.id)
  const tasks = Array.isArray(record?.tasks) ? record.tasks : []
  return {
    key,
    agent: peerText(row.agent, 20),
    agentLabel: label(row.agent),
    id: sanitize(String(row.id), ID_MAX),
    name: row.name,
    state: row.state,
    alive: row.alive,
    native: row.native,
    waitingFor: row.waitingFor,
    since: num(row.since) ?? 0,
    startedAt: record ? num(record.startedAt) : null,
    turns: num(row.turns),
    done: row.done,
    doing: row.doing,
    next: row.next,
    tasks: row.tasks,
    taskList: tasks.slice(0, TASKS_SHOWN).map((t) => ({ text: peerText(t?.text, 200), status: TASK_STATUS.has(t?.status) ? t.status : 'pending' })),
    files: row.files,
    lastEditAt: record ? lastEdit(record.edits) : null,
    cwd: pathOrNull(row.cwd) ?? '',
    project: peerText(row.project, 60),
    projectId: row.native ? cwdProjectId(row.cwd) : typeof record?.projectId === 'string' ? record.projectId : null,
    worktree: pathOrNull(row.worktree),
    home: pathOrNull(row.home),
    prompt: record ? textOrNull(record.lastPrompt, 300) : null,
    answer: record ? textOrNull(record.lastAnswer, 300) : null,
    unread: row.native ? 0 : unreadCount(store, key, now),
    hat: hatOf(store, key),
    canResume: canResume(row.agent),
  }
}

// The monitor's list (scope all, no caller), each row joined to the record it came from.
// listSessions wants a project even for scope all; with no caller it only names a worktree that
// nothing is compared with, so the store's own folder serves.
// Ended sessions come too (the page's "Show ended" draws them with their resume command), but only
// the last day's and at most ENDED_MAX: records live 7 days, which is hundreds at a busy pace.
// listSessions sorts them last, newest first, so live rows are never cut for them.
function sessionsOf(store, { anchor, now, env, records }) {
  const byId = new Map(records.map((r) => [`${r.agent}:${r.id}`, r]))
  const { data } = listSessions(store, { scope: 'all', project: anchor, me: null, now, includeEnded: true, limit: SESSIONS_MAX, env })
  let ended = 0
  const rows = data.sessions.filter((row) => {
    if (row.state !== 'ended') return true
    if (now - row.since > ENDED_SHOWN_MS || ended >= ENDED_MAX) return false
    ended++
    return true
  })
  return rows.map((row) => sessionOf(store, row, row.native ? null : byId.get(`${row.agent}:${row.id}`) ?? null, now))
}

function countsOf(sessions) {
  const count = (state) => sessions.filter((s) => s.state === state).length
  return { needsYou: count('waiting'), working: count('working'), done: count('idle'), open: count('open'), running: sessions.filter((s) => s.state !== 'ended').length }
}

// fileClashes' groups (newest first) with each session named, never the raw record (it holds
// prompts and paths).
function clashesOf(store, { anchor, now }) {
  return fileClashes(store, { scope: 'all', project: anchor, now }).slice(0, CLASHES_SHOWN).map((g) => ({
    file: peerText(g.file, 160),
    worktree: pathOrNull(g.worktree),
    edits: g.edits.map(({ session: s, at }) => ({ key: sessionKey(s.agent, s.id), agent: peerText(s.agent, 20), agentLabel: label(s.agent), name: peerText(nameOf(s), 60), at })),
  }))
}

// --- projects -------------------------------------------------------------------------------------

// The folder a writer can work in: the first of repoKey, then the aliases newest first, that still
// exists and still maps to this project. An alias can be a deleted worktree, and projectInfo on a
// missing path walks up into whatever project holds it.
export function projectFolder(meta, projectId) {
  if (!isObject(meta)) return null
  const aliases = Array.isArray(meta.aliases) ? [...meta.aliases].reverse() : []
  for (const dir of [meta.repoKey, ...aliases]) {
    if (typeof dir !== 'string' || !dir) continue
    try {
      if (fs.existsSync(dir) && projectInfo(dir).projectId === projectId) return dir
    } catch {}
  }
  return null
}

// takenBy names the agent and the time, never the session key: the page only says who has it.
function ideaOf(idea) {
  const by = isObject(idea.takenBy) ? idea.takenBy : null
  return {
    id: peerText(idea.id, 64),
    text: peerText(idea.text, 300),
    source: idea.source,
    createdAt: num(idea.createdAt),
    status: idea.status,
    files: (idea.files ?? []).map((f) => peerText(f, 300)),
    takenBy: idea.status === 'taken' && by ? { agent: peerText(by.agent, 20), agentLabel: label(by.agent), at: num(by.at) } : null,
  }
}

function projectOf(store, projectId, { now, live }) {
  const ref = { projectId }
  const shelf = readShelf(store, ref)
  const shelved = ordered(shelf, now, true)
  // An add appends to the shelf, so its end is newest; the ones kept stay in the CLI's order (open
  // first, then taken), and a just-added idea is always among them.
  const newest = new Set(shelf.ideas.slice(-IDEAS_SHOWN))
  const ideas = shelved.filter((idea) => newest.has(idea)).map((idea) => ideaOf(publicIdea(idea, now)))
  const doc = normalizeDoc(store.readJson(projectFile(ref, ASSUMPTIONS_FILE), null))
  // Newest first the way `assumptions list` orders them: the file appends, so the end is newest.
  const open = doc.items.filter(STATUS.open).reverse()
  // Rules and decisions append too (a re-made decision moves to the end): the newest are the last
  // ones, kept below in file order.
  const decisions = loadDecisions(store, ref).filter(isObject)
  if (!live && !shelved.length && !open.length && !doc.rules.length && !decisions.length) return null
  const meta = store.readJson(projectFile(ref, 'meta.json'), null)
  return {
    id: projectId,
    name: peerText(typeof meta?.name === 'string' && meta.name ? meta.name : projectId, 80),
    path: pathOrNull(meta?.repoKey),
    actionable: projectFolder(meta, projectId) !== null,
    live,
    ideas,
    ideasCount: shelved.length,
    openAssumptions: open.length,
    assumptions: open.slice(0, ASSUMPTIONS_SHOWN).map((a) => ({
      id: a.id,
      text: peerText(a.text, 500),
      context: textOrNull(a.context, 500),
      agent: textOrNull(a.agent, 20),
      at: num(a.at),
    })),
    rules: doc.rules.slice(-RULES_SHOWN).map((r) => ({ id: r.id, assumption: peerText(r.assumption, 500), correction: peerText(r.correction, 500), at: num(r.at) })),
    decisions: decisions.slice(-DECISIONS_SHOWN).map((d) => ({
      question: peerText(d.question, 500),
      topic: textOrNull(d.topic, 120),
      choice: peerText(d.choice, 500),
      description: textOrNull(d.description, 500),
      at: num(d.at),
      agent: textOrNull(d.agent, 20),
    })),
  }
}

function projectsOf(store, { now, sessions }) {
  const live = new Map()
  for (const s of sessions) if (s.state !== 'ended' && s.projectId) live.set(s.projectId, (live.get(s.projectId) ?? 0) + 1)
  const out = []
  for (const entry of store.list('projects')) {
    if (!entry.isDirectory() || !PROJECT_ID.test(entry.name)) continue
    const project = guard(store, `project ${entry.name}`, () => projectOf(store, entry.name, { now, live: live.get(entry.name) ?? 0 }), null)
    if (project) out.push(project)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.id < b.id ? -1 : 1))
}

// --- settings and health --------------------------------------------------------------------------

// plain.mjs readSettings without its tidy-up write: the same level rule and the same cleaned terms.
function plainOf(store) {
  const raw = store.readJson('plain.json', null)
  const settings = isObject(raw) ? raw : {}
  return {
    level: LEVELS.includes(settings.level) ? settings.level : PLAIN_OFF,
    terms: Array.isArray(settings.terms) ? cleanTerms(settings.terms).map((t) => peerText(t, 60)) : [],
  }
}

function clawdOf(store) {
  const prefs = readPrefs(store)
  return { hat: prefs.hat, shades: prefs.shades, hidden: prefs.hidden }
}

// Each file on its own: an unreadable config.json still leaves plain and clawd showing.
function settingsOf(store) {
  const config = guard(store, 'config', () => loadConfig(store), DEFAULT_CONFIG)
  return {
    plain: guard(store, 'plain', () => plainOf(store), { level: PLAIN_OFF, terms: [] }),
    notify: notifySettings(config),
    clawd: guard(store, 'clawd', () => clawdOf(store), { hat: null, shades: false, hidden: false }),
    // The runtime skips a mod only when its switch is exactly false.
    mods: Object.fromEntries(Object.keys(DEFAULT_CONFIG.mods).map((name) => [name, config.mods?.[name] !== false])),
  }
}

function newestBeat(records, agent) {
  let newest = null
  for (const r of records) if (r.agent === agent && Number.isFinite(r.beatAt) && (newest === null || r.beatAt > newest)) newest = r.beatAt
  return newest
}

function parseErrors(text) {
  let count = 0
  let lastAt = null
  let last = null
  for (const line of String(text).split(/\r?\n/)) {
    const match = ENTRY_START.exec(line)
    if (!match) continue
    count++
    lastAt = num(Date.parse(match[1]))
    last = peerText(line, ERROR_TEXT_MAX)
  }
  return { count, lastAt, last }
}

// The log is up to ~260 KB and changes rarely: it is re-read only when its mtime:size stamp moves.
const errorCache = new Map()

function errorsOf(store) {
  const file = store.path('logs', 'errors.log')
  let stamp
  try {
    const stat = fs.statSync(file)
    stamp = `${stat.mtimeMs}:${stat.size}`
  } catch {
    return { ...NO_ERRORS }
  }
  const cached = errorCache.get(file)
  if (cached?.stamp !== stamp) errorCache.set(file, { stamp, value: parseErrors(fs.readFileSync(file, 'utf8')) })
  return { ...errorCache.get(file).value }
}

function serverOf(server) {
  return isObject(server) ? { pid: num(server.pid), startedAt: num(server.startedAt), port: num(server.port) } : null
}

function healthOf(store, { records, sessions, server }) {
  return {
    agents: HEALTH_AGENTS.map((agent) => ({
      agent,
      label: agentLabel(agent),
      lastSeen: newestBeat(records, agent),
      live: sessions.filter((s) => s.agent === agent && s.state !== 'ended').length,
    })),
    errors: guard(store, 'errors', () => errorsOf(store), { ...NO_ERRORS }),
    store: pathOrNull(store.root),
    server: serverOf(server),
  }
}

// --- the snapshot ---------------------------------------------------------------------------------

export function buildSnapshot(store, { now = Date.now(), env = process.env, server = null } = {}) {
  const reads = cachedReads(store)
  try {
    return snapshotOf(reads.store, { now, env, server })
  } finally {
    reads.keep()
  }
}

function snapshotOf(store, { now, env, server }) {
  const anchor = projectInfo(store.root)
  const records = guard(store, 'records', () => listRecords(store), [])
  const sessions = guard(store, 'sessions', () => sessionsOf(store, { anchor, now, env, records }), [])
  return {
    v: SNAPSHOT_VERSION,
    at: now,
    sessions,
    counts: countsOf(sessions),
    clashes: guard(store, 'clashes', () => clashesOf(store, { anchor, now }), []),
    projects: guard(store, 'projects', () => projectsOf(store, { now, sessions }), []),
    settings: settingsOf(store),
    health: healthOf(store, { records, sessions, server }),
  }
}

// What the page is pushed on: everything but the build time, so an unchanged store sends nothing.
export function signature(snapshot) {
  return sha1(JSON.stringify({ ...snapshot, at: 0 }))
}
