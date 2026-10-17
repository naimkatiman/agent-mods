// The dashboard's data side: the snapshot (sessions joined to their records, clashes, projects,
// settings, health) built from the functions the CLI uses, and the activity feed from the event log.
// Every build is a pure read, so several tests compare the store before and after.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createActivity } from '../lib/dashboard/activity.mjs'
import { buildSnapshot, signature } from '../lib/dashboard/snapshot.mjs'
import { projectInfo } from '../lib/core/project.mjs'
import { recordRel } from '../lib/core/session-records.mjs'
import { projectFile, sessionKey, setConfigValue, touchProjectMeta } from '../lib/core/store.mjs'
import { eventRel } from '../lib/mods/clawd.mjs'
import { addDecisions } from '../lib/mods/design.mjs'
import { addIdea, takeIdeas } from '../lib/mods/ideas-shelf.mjs'
import { inboxDir, queueMessage } from '../lib/mods/sessions-data.mjs'
import { makeRepo, tempDir, tempStore } from './helpers.mjs'

const MIN = 60_000
const HOUR = 60 * MIN
const NO_NATIVE = JSON.stringify({ claude: [], grok: [] })

function setup(name = 'shop') {
  const s = tempStore()
  const cwd = makeRepo(name)
  const project = projectInfo(cwd)
  const now = Date.now()
  touchProjectMeta(s.store, project, now)
  return { ...s, env: { ...s.env, AGENT_MODS_NATIVE_HOMES: NO_NATIVE }, cwd, project, now }
}

const build = (t, extra = {}) => buildSnapshot(t.store, { now: t.now, env: t.env, ...extra })

// A record as the sessions mod writes it: pid and home null, so liveness is the 30-minute heartbeat.
function writeRecord(t, fields = {}) {
  const record = {
    v: 1,
    agent: 'codex',
    id: 'peer-0001',
    home: null,
    pid: null,
    cwd: t.project.cwd,
    worktreeKey: t.project.worktreeKey,
    repoKey: t.project.repoKey,
    projectId: t.project.projectId,
    startedAt: t.now - HOUR,
    beatAt: t.now,
    endedAt: null,
    state: 'working',
    waitingFor: null,
    turns: 3,
    turnStartedAt: t.now - 5 * MIN,
    lastPrompt: 'fix auth',
    lastAnswer: null,
    title: 'Auth fix',
    done: null,
    doing: null,
    next: null,
    tasks: [],
    files: [],
    edits: {},
    ...fields,
  }
  record.key = sessionKey(record.agent, record.id)
  t.store.writeJson(recordRel(record.key), record)
  return record
}

// Every file under the store with its size, mtime and bytes: a build must leave all of it as it was.
function tree(root) {
  const out = {}
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        const stat = fs.statSync(full)
        out[path.relative(root, full)] = `${stat.size}:${stat.mtimeMs}:${fs.readFileSync(full, 'base64')}`
      }
    }
  }
  walk(root)
  return out
}

// --- sessions ----------------------------------------------------------------------------------------

test('snapshot: sessions in state order with counts; ended ones come last and are not counted; never-prompted ones are hidden', () => {
  const t = setup()
  writeRecord(t, { agent: 'codex', id: 'work-0001', title: 'Refactor parser', state: 'working', beatAt: t.now - MIN })
  writeRecord(t, { agent: 'claude', id: 'wait-0001', title: 'Fix login', state: 'waiting', waitingFor: 'approve Bash', beatAt: t.now - 2 * MIN })
  writeRecord(t, { agent: 'grok', id: 'done-0001', title: 'Tidy README', state: 'idle', beatAt: t.now - 3 * MIN })
  writeRecord(t, { agent: 'claude', id: 'ended-001', title: 'Old work', state: 'ended', beatAt: t.now - 10 * MIN, endedAt: t.now - 10 * MIN })
  // No endedAt, but its heartbeat ran out 2 h ago: the monitor reads it as ended, and so does the page.
  writeRecord(t, { agent: 'codex', id: 'stale-001', title: 'Stale', state: 'working', beatAt: t.now - 2 * HOUR })
  writeRecord(t, { agent: 'devin', id: 'quiet-001', title: null, lastPrompt: null, state: 'idle' })

  const snap = build(t)
  assert.equal(snap.v, 1)
  assert.equal(snap.at, t.now)
  assert.deepEqual(snap.sessions.map((s) => [s.agent, s.id, s.state, s.name]), [
    ['claude', 'wait-0001', 'waiting', 'Fix login'],
    ['codex', 'work-0001', 'working', 'Refactor parser'],
    ['grok', 'done-0001', 'idle', 'Tidy README'],
    ['claude', 'ended-001', 'ended', 'Old work'],
    ['codex', 'stale-001', 'ended', 'Stale'],
  ])
  assert.deepEqual(snap.counts, { needsYou: 1, working: 1, done: 1, open: 0, running: 3 })
  assert.equal(snap.sessions[0].waitingFor, 'approve Bash')
  assert.equal(snap.sessions[0].agentLabel, 'Claude Code')
  assert.equal(snap.sessions[1].waitingFor, '')
  assert.equal(snap.sessions[3].alive, false)
})

test('snapshot: ended sessions older than 24 h are left out, and at most 30 ended ones are kept, newest first', () => {
  const t = setup()
  writeRecord(t, { agent: 'codex', id: 'live-0001', title: 'Live one', state: 'working', beatAt: t.now - MIN })
  writeRecord(t, { agent: 'claude', id: 'olden-001', title: 'Yesterday', state: 'ended', beatAt: t.now - 25 * HOUR, endedAt: t.now - 25 * HOUR })
  for (let i = 0; i < 35; i++) {
    const at = t.now - (i + 1) * 10 * MIN
    writeRecord(t, { agent: 'claude', id: `end-${String(i).padStart(5, '0')}`, title: `Ended ${i}`, state: 'ended', beatAt: at, endedAt: at })
  }

  const ended = build(t).sessions.filter((s) => s.state === 'ended')
  assert.equal(ended.length, 30)
  assert.equal(ended[0].name, 'Ended 0', 'newest first')
  assert.equal(ended.at(-1).name, 'Ended 29')
  assert.ok(!ended.some((s) => s.name === 'Yesterday'), 'an ended session older than 24 h is left out')
})

test('snapshot: a session row carries its record: prompt, answer, tasks, times, unread and hat', () => {
  const t = setup()
  const tasks = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, text: `step ${i + 1}`, status: i < 3 ? 'completed' : i === 3 ? 'in_progress' : 'pending' }))
  const r = writeRecord(t, {
    lastPrompt: 'fix\u0007 the auth‮ flow',
    lastAnswer: 'Patched the middleware.',
    tasks,
    files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts'],
    edits: { 'src/a.ts': t.now - 2 * MIN, 'src/b.ts': t.now - 9 * MIN },
  })
  queueMessage(t.store, r.key, { from: { agent: 'claude', id: 'x', title: 'one' }, at: t.now - MIN, text: 'fresh one' }, t.now - MIN)
  queueMessage(t.store, r.key, { from: { agent: 'claude', id: 'x', title: 'two' }, at: t.now, text: 'fresh two' }, t.now)
  queueMessage(t.store, r.key, { from: { agent: 'claude', id: 'x', title: 'old' }, at: t.now - 25 * HOUR, text: 'expired' }, t.now - 25 * HOUR)
  fs.writeFileSync(path.join(inboxDir(t.store, r.key), `${t.now}-abcd.json.tmp.1.ff`), '{}')
  t.store.writeJson(`sessions/${r.key}/clawd.json`, { hat: 'crown' })
  const inboxBefore = fs.readdirSync(inboxDir(t.store, r.key)).sort()

  const [s] = build(t).sessions
  assert.deepEqual(
    { key: s.key, agent: s.agent, id: s.id, native: s.native, alive: s.alive, since: s.since, startedAt: s.startedAt, turns: s.turns },
    { key: 'codex__peer-0001', agent: 'codex', id: 'peer-0001', native: false, alive: true, since: t.now, startedAt: t.now - HOUR, turns: 3 },
  )
  assert.equal(s.prompt, 'fix the auth flow', 'control and bidi characters are stripped')
  assert.equal(s.answer, 'Patched the middleware.')
  assert.deepEqual(s.tasks, { done: 3, total: 12 })
  assert.equal(s.taskList.length, 10)
  assert.deepEqual(s.taskList[3], { text: 'step 4', status: 'in_progress' })
  assert.equal(s.doing, 'step 4')
  assert.equal(s.next, 'step 5')
  assert.deepEqual(s.files, ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'])
  assert.equal(s.lastEditAt, t.now - 2 * MIN)
  assert.equal(s.unread, 2, 'the expired message and the temp file do not count')
  assert.deepEqual(fs.readdirSync(inboxDir(t.store, r.key)).sort(), inboxBefore, 'counting never consumes or deletes')
  assert.equal(s.hat, 'crown')
  assert.equal(s.canResume, true)
  assert.deepEqual([s.cwd, s.project, s.projectId, s.worktree, s.home], [t.project.cwd, 'shop', t.project.projectId, t.project.worktreeKey, null])
})

test('snapshot: a native-only row has no record fields: null startedAt, no tasks, no prompt, no unread', () => {
  const t = setup('native')
  const claudeHome = tempDir('am-fake-claude-')
  fs.mkdirSync(path.join(claudeHome, 'sessions'))
  fs.writeFileSync(
    path.join(claudeHome, 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: 'native-claude-1', cwd: t.cwd, status: 'busy', statusUpdatedAt: t.now - 5_000, name: 'Native work', nameSource: 'user' }),
  )
  const snap = build(t, { env: { ...t.env, AGENT_MODS_NATIVE_HOMES: JSON.stringify({ claude: [claudeHome], grok: [] }) } })
  const [s] = snap.sessions
  assert.deepEqual(
    { key: s.key, native: s.native, state: s.state, name: s.name, startedAt: s.startedAt, turns: s.turns, taskList: s.taskList, tasks: s.tasks, prompt: s.prompt, answer: s.answer, unread: s.unread, hat: s.hat, lastEditAt: s.lastEditAt, projectId: s.projectId },
    { key: 'claude__native-claude-1', native: true, state: 'working', name: 'Native work', startedAt: null, turns: null, taskList: [], tasks: null, prompt: null, answer: null, unread: 0, hat: null, lastEditAt: null, projectId: t.project.projectId },
  )
  assert.equal(snap.counts.working, 1)
})

test('snapshot: clashes name the sessions that edited one file, never their raw records', () => {
  const t = setup()
  const a = writeRecord(t, { agent: 'claude', id: 'clash-a01', title: 'Login page', edits: { 'src/auth.ts': t.now - 4 * MIN, 'src/only-a.ts': t.now - MIN } })
  const b = writeRecord(t, { agent: 'codex', id: 'clash-b01', title: 'Auth fix', edits: { 'src/auth.ts': t.now - MIN } })
  writeRecord(t, { agent: 'grok', id: 'clash-c01', title: 'Ended', endedAt: t.now - MIN, edits: { 'src/auth.ts': t.now - 2 * MIN } })
  const { clashes } = build(t)
  assert.deepEqual(clashes, [
    {
      file: 'src/auth.ts',
      worktree: t.project.worktreeKey,
      edits: [
        { key: b.key, agent: 'codex', agentLabel: 'Codex', name: 'Auth fix', at: t.now - MIN },
        { key: a.key, agent: 'claude', agentLabel: 'Claude Code', name: 'Login page', at: t.now - 4 * MIN },
      ],
    },
  ])
})

// --- projects ----------------------------------------------------------------------------------------

test('snapshot: projects show ideas, open assumptions newest first, rules, decisions and live sessions', () => {
  const t = setup('shop')
  const first = addIdea(t.store, t.project, { text: 'Cache the parser output', source: 'you', now: t.now - 3 * MIN })
  const second = addIdea(t.store, t.project, { text: 'Split the auth module', files: ['src/auth.ts'], source: 'codex', now: t.now - 2 * MIN })
  takeIdeas(t.store, t.project, [first.idea.id], { agent: 'claude', sessionKey: 'claude__x', now: t.now - MIN })
  t.store.writeJson(projectFile(t.project, 'assumptions.json'), {
    v: 1,
    lastId: 3,
    items: [
      { id: 1, text: 'uses npm', verdict: 'open', isSent: false, agent: 'claude', sessionKey: null, at: t.now - 3 * MIN },
      { id: 2, text: 'old one', verdict: 'right', isSent: true, agent: 'claude', sessionKey: null, at: t.now - 4 * MIN },
      { id: 3, text: 'tabs\u0007 not spaces', context: 'formatting', verdict: 'open', isSent: false, agent: 'codex', sessionKey: 'codex__y', at: t.now - MIN },
    ],
    rules: [{ id: 1, assumption: 'uses yarn', correction: 'use pnpm', by: 'user', at: t.now - 10 * MIN }],
  })
  addDecisions(t.store, t.project, [{ question: 'Card style?', topic: 'cards', choice: 'Flat cards', description: 'hairline borders', at: t.now - 4 * MIN, agent: 'claude', sessionKey: null }])
  writeRecord(t)
  const empty = projectInfo(makeRepo('empty'))
  touchProjectMeta(t.store, empty, t.now)
  const ended = projectInfo(makeRepo('ended'))
  touchProjectMeta(t.store, ended, t.now)
  writeRecord(t, { id: 'over-0001', cwd: ended.cwd, worktreeKey: ended.worktreeKey, repoKey: ended.repoKey, projectId: ended.projectId, endedAt: t.now - MIN })

  const snap = build(t)
  assert.deepEqual(snap.projects.map((p) => p.id), [t.project.projectId], 'projects with nothing to show are left out')
  const [p] = snap.projects
  assert.deepEqual([p.name, p.path, p.actionable, p.live, p.openAssumptions], ['shop', t.project.repoKey, true, 1, 2])
  assert.deepEqual(p.ideas, [
    { id: second.idea.id, text: 'Split the auth module', source: 'codex', createdAt: t.now - 2 * MIN, status: 'open', files: ['src/auth.ts'], takenBy: null },
    { id: first.idea.id, text: 'Cache the parser output', source: 'you', createdAt: t.now - 3 * MIN, status: 'taken', files: [], takenBy: { agent: 'claude', agentLabel: 'Claude Code', at: t.now - MIN } },
  ])
  assert.deepEqual(p.assumptions, [
    { id: 3, text: 'tabs not spaces', context: 'formatting', agent: 'codex', at: t.now - MIN },
    { id: 1, text: 'uses npm', context: null, agent: 'claude', at: t.now - 3 * MIN },
  ])
  assert.deepEqual(p.rules, [{ id: 1, assumption: 'uses yarn', correction: 'use pnpm', at: t.now - 10 * MIN }])
  assert.deepEqual(p.decisions, [{ question: 'Card style?', topic: 'cards', choice: 'Flat cards', description: 'hairline borders', at: t.now - 4 * MIN, agent: 'claude' }])
})

test('snapshot: open assumptions are capped at 100 newest; a project whose folder is gone is not actionable', () => {
  const t = setup('busy')
  const items = Array.from({ length: 105 }, (_, i) => ({ id: i + 1, text: `guess ${i + 1}`, verdict: 'open', isSent: false, agent: 'claude', sessionKey: null, at: t.now - (105 - i) * MIN }))
  t.store.writeJson(projectFile(t.project, 'assumptions.json'), { v: 1, lastId: 105, items, rules: [] })
  const gone = projectInfo(makeRepo('gone'))
  touchProjectMeta(t.store, gone, t.now)
  addIdea(t.store, gone, { text: 'Left behind', source: 'you', now: t.now })
  fs.rmSync(gone.repoKey, { recursive: true, force: true })

  const snap = build(t)
  const busy = snap.projects.find((p) => p.id === t.project.projectId)
  assert.equal(busy.openAssumptions, 105)
  assert.equal(busy.assumptions.length, 100)
  assert.deepEqual([busy.assumptions[0].id, busy.assumptions.at(-1).id], [105, 6])
  assert.equal(busy.actionable, true)
  const lost = snap.projects.find((p) => p.id === gone.projectId)
  assert.equal(lost.actionable, false)
  assert.deepEqual(lost.ideas.map((i) => i.text), ['Left behind'])
})

// --- settings and health -------------------------------------------------------------------------------

test('snapshot: settings are pure reads; an untidy plain.json is shown tidy but never rewritten', () => {
  const t = setup()
  const plainFile = t.store.path('plain.json')
  fs.writeFileSync(plainFile, JSON.stringify({ level: 'beginner', terms: ['API: a way programs talk', 'Kubernetes', 'kubernetes'] }))
  setConfigValue(t.store, 'notify.enabled', true)
  setConfigValue(t.store, 'mods.design', false)
  t.store.writeJson('clawd.json', { hat: 'crown', shades: true, hidden: false, lastGc: 1 })
  writeRecord(t, { edits: { 'src/a.ts': t.now - MIN } })
  queueMessage(t.store, 'codex__peer-0001', { from: { agent: 'cli', id: null, title: null }, at: t.now - 25 * HOUR, text: 'expired' }, t.now - 25 * HOUR)
  const before = tree(t.root)

  const { settings } = build(t)
  assert.deepEqual(settings.plain, { level: 'beginner', terms: ['api', 'kubernetes'] })
  assert.deepEqual(settings.notify, { enabled: true, afterMs: 30_000, sound: true })
  assert.deepEqual(settings.clawd, { hat: 'crown', shades: true, hidden: false })
  assert.deepEqual(settings.mods, { sessions: true, assumptions: true, design: false, plain: true, ideas: true, enhance: true, clawd: true })
  assert.deepEqual(tree(t.root), before, 'the build wrote, renamed or deleted nothing')

  fs.writeFileSync(plainFile, JSON.stringify({ level: 'shouting', terms: 'not a list' }))
  assert.deepEqual(build(t).settings.plain, { level: 'off', terms: [] })
})

test('snapshot: health has last seen and live sessions per agent, the parsed error log, store and server', () => {
  const t = setup()
  writeRecord(t, { agent: 'claude', id: 'live-0001', beatAt: t.now })
  writeRecord(t, { agent: 'codex', id: 'old-00001', beatAt: t.now - 3 * HOUR, endedAt: t.now - 3 * HOUR })
  writeRecord(t, { agent: 'codex', id: 'old-00002', beatAt: t.now - 5 * HOUR, endedAt: t.now - 5 * HOUR })
  writeRecord(t, { agent: 'grok', id: 'quiet-001', lastPrompt: null, beatAt: t.now - MIN })
  const server = { pid: 4242, startedAt: t.now - HOUR, port: 4747 }

  const quiet = build(t, { server })
  assert.deepEqual(quiet.health.agents, [
    { agent: 'claude', label: 'Claude Code', lastSeen: t.now, live: 1 },
    { agent: 'codex', label: 'Codex', lastSeen: t.now - 3 * HOUR, live: 0 },
    { agent: 'grok', label: 'Grok', lastSeen: t.now - MIN, live: 0 },
    { agent: 'devin', label: 'Devin', lastSeen: null, live: 0 },
  ])
  assert.deepEqual(quiet.health.errors, { count: 0, lastAt: null, last: null })
  assert.equal(quiet.health.store, t.root)
  assert.deepEqual(quiet.health.server, server)
  assert.equal(build(t).health.server, null)

  const log = t.store.path('logs', 'errors.log')
  fs.mkdirSync(path.dirname(log), { recursive: true })
  fs.writeFileSync(log, [
    '2026-10-12T08:00:00.000Z meta: Error: first',
    '    at x (file.mjs:1:1)',
    '2026-10-12T09:30:00.000Z mcp: Error: boom\u0007‮',
    '    at y (file.mjs:2:2)',
    '    at z (file.mjs:3:3)',
    '',
  ].join('\n'))
  assert.deepEqual(build(t).health.errors, { count: 2, lastAt: Date.parse('2026-10-12T09:30:00.000Z'), last: '2026-10-12T09:30:00.000Z mcp: Error: boom' })
  fs.appendFileSync(log, `2026-10-12T10:00:00.000Z ${'x'.repeat(300)}\n`)
  const errors = build(t).health.errors
  assert.equal(errors.count, 3)
  assert.equal(errors.lastAt, Date.parse('2026-10-12T10:00:00.000Z'))
  assert.equal(errors.last.length, 200)
  assert.ok(errors.last.endsWith('…'))
})

test('snapshot: unchanged store files are not opened again; a changed or removed one is seen at once', () => {
  const t = setup()
  writeRecord(t, { title: 'AAAA' })
  addIdea(t.store, t.project, { text: 'First idea', source: 'you', now: t.now })
  const reads = []
  const counting = { ...t.store, readJson: (rel, fallback) => (reads.push(String(rel).replace(/\\/g, '/')), t.store.readJson(rel, fallback)) }
  const again = () => buildSnapshot(counting, { now: t.now, env: t.env })
  assert.equal(again().sessions[0].name, 'AAAA')
  assert.ok(reads.some((rel) => rel.endsWith('sessions/codex__peer-0001.json')))
  reads.length = 0
  again()
  assert.deepEqual(reads.filter((rel) => /sessions\/[^/]+\.json$|ideas\.json$|meta\.json$/.test(rel)), [], 'records and project files come from the cache')
  writeRecord(t, { title: 'BBBB' })
  assert.equal(again().sessions[0].name, 'BBBB', 'a same-size rewrite still moves the stamp')
  addIdea(t.store, t.project, { text: 'Second idea', source: 'you', now: t.now })
  assert.equal(again().projects[0].ideas.length, 2)
  t.store.remove(recordRel('codex__peer-0001'))
  assert.deepEqual(again().sessions, [])
})

test('snapshot: the signature ignores the build time and follows the data', () => {
  const t = setup()
  writeRecord(t)
  addIdea(t.store, t.project, { text: 'First idea', source: 'you', now: t.now })
  const a = build(t)
  const b = buildSnapshot(t.store, { now: t.now + 1_000, env: t.env })
  assert.notEqual(a.at, b.at)
  assert.equal(signature(a), signature(b))
  assert.equal(typeof signature(a), 'string')
  addIdea(t.store, t.project, { text: 'Second idea', source: 'you', now: t.now })
  assert.notEqual(signature(build(t)), signature(a))
})

// --- activity ------------------------------------------------------------------------------------------

const NOON = new Date(2026, 9, 11, 12, 0, 0).getTime()

function eventLine(store, line) {
  fs.mkdirSync(store.path('events'), { recursive: true })
  fs.appendFileSync(store.path(eventRel(line.t ?? NOON)), `${typeof line === 'string' ? line : JSON.stringify(line)}\n`)
}

function rawLine(store, text) {
  fs.mkdirSync(store.path('events'), { recursive: true })
  fs.appendFileSync(store.path(eventRel(NOON)), `${text}\n`)
}

test('activity: event lines are cleaned: sid is key, pk is projectId, text sanitized and clipped to 60', () => {
  const { store } = tempStore()
  const base = { v: 1, agent: 'claude', sid: 'claude__abc-1', pk: 'shop-1234abcd', project: 'shop' }
  eventLine(store, { ...base, t: NOON - 40 * MIN, ev: 'prompt.submit' })
  eventLine(store, { ...base, t: NOON - 5 * MIN, ev: 'session.start', hat: 'crown' })
  eventLine(store, { ...base, t: NOON - 4 * MIN, ev: 'tool.post', kind: 'edit', label: `auth\u0007‮${'x'.repeat(80)}.ts`, ok: false })
  eventLine(store, { v: 1, t: NOON - 3 * MIN, agent: null, sid: null, pk: null, project: '', ev: 'clawd.cmd', verb: 'shades', arg: 'y'.repeat(80), shades: true, hat: 'not-a-hat' })
  rawLine(store, 'not json')
  rawLine(store, JSON.stringify({ ...base, t: NOON - 2 * MIN }))
  rawLine(store, JSON.stringify({ ...base, t: 'yesterday', ev: 'turn.stop' }))
  rawLine(store, JSON.stringify({ ...base, t: NOON - 2 * MIN, ev: 'turn.stop', sid: '../../etc__x' }))
  rawLine(store, JSON.stringify({ ...base, t: NOON - 2 * MIN, ev: 'turn.stop', pk: '../x' }))

  const activity = createActivity(store, { now: NOON })
  const seeded = activity.seed()
  assert.deepEqual(seeded, [
    { t: NOON - 5 * MIN, agent: 'claude', agentLabel: 'Claude Code', key: 'claude__abc-1', projectId: 'shop-1234abcd', project: 'shop', ev: 'session.start', hat: 'crown' },
    { t: NOON - 4 * MIN, agent: 'claude', agentLabel: 'Claude Code', key: 'claude__abc-1', projectId: 'shop-1234abcd', project: 'shop', ev: 'tool.post', kind: 'edit', label: `auth${'x'.repeat(55)}…`, ok: false },
    { t: NOON - 3 * MIN, agent: null, agentLabel: null, key: null, projectId: null, project: '', ev: 'clawd.cmd', verb: 'shades', arg: `${'y'.repeat(59)}…`, shades: true },
  ])
  assert.equal(seeded[1].label.length, 60)
  assert.deepEqual(activity.recent(), seeded)
  assert.deepEqual(activity.seed(), seeded, 'seeding twice adds nothing')

  eventLine(store, { ...base, t: NOON + 1_000, ev: 'turn.stop' })
  rawLine(store, '{"half": ')
  const fresh = activity.read(NOON + 2_000)
  assert.deepEqual(fresh, [{ t: NOON + 1_000, agent: 'claude', agentLabel: 'Claude Code', key: 'claude__abc-1', projectId: 'shop-1234abcd', project: 'shop', ev: 'turn.stop' }])
  assert.deepEqual(activity.read(NOON + 3_000), [], 'only new lines')
  assert.equal(activity.recent().length, 4)
  activity.read(NOON + 28 * MIN)
  assert.deepEqual(activity.recent().map((l) => l.t), [NOON + 1_000], 'lines older than 30 minutes leave the buffer')
})

test('activity: the buffer keeps at most `max` lines, newest last', () => {
  const { store } = tempStore()
  for (let i = 0; i < 6; i++) eventLine(store, { v: 1, t: NOON - (6 - i) * 1_000, agent: 'codex', sid: `codex__s${i}`, pk: 'p-1', project: 'p', ev: 'prompt.submit' })
  const activity = createActivity(store, { now: NOON, max: 3 })
  assert.deepEqual(activity.seed().map((l) => l.key), ['codex__s3', 'codex__s4', 'codex__s5'])
  for (let i = 6; i < 8; i++) eventLine(store, { v: 1, t: NOON + i, agent: 'codex', sid: `codex__s${i}`, pk: 'p-1', project: 'p', ev: 'prompt.submit' })
  assert.equal(activity.read(NOON + 100).length, 2)
  assert.deepEqual(activity.recent().map((l) => l.key), ['codex__s5', 'codex__s6', 'codex__s7'])
  const empty = createActivity(tempStore().store, { now: NOON })
  assert.deepEqual([empty.seed(), empty.read(NOON + 1), empty.recent()], [[], [], []], 'no event log yet is not an error')
})

test('snapshot: a taken idea says which agent took it and when, never the session key', () => {
  const t = setup()
  const { idea } = addIdea(t.store, t.project, { text: 'Cache the candle API response for 60 s', source: 'you', now: t.now - 10 * MIN })
  writeRecord(t, { agent: 'codex', id: 'taker-001', title: 'Taker' })
  takeIdeas(t.store, t.project, [idea.id], { agent: 'codex', sessionKey: sessionKey('codex', 'taker-001'), now: t.now - MIN })

  const shown = build(t).projects.find((p) => p.id === t.project.projectId).ideas.find((i) => i.id === idea.id)
  assert.equal(shown.status, 'taken')
  assert.deepEqual(shown.takenBy, { agent: 'codex', agentLabel: 'Codex', at: t.now - MIN })
})
