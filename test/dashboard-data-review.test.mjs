// Fixes from the 2026-10-12 adversarial review of the dashboard data: the snapshot, the activity feed
// and send.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runAction } from '../lib/dashboard/actions.mjs'
import { KEEP_MS, createActivity } from '../lib/dashboard/activity.mjs'
import { buildSnapshot } from '../lib/dashboard/snapshot.mjs'
import { projectInfo } from '../lib/core/project.mjs'
import { recordRel } from '../lib/core/session-records.mjs'
import { projectFile, sessionKey, touchProjectMeta } from '../lib/core/store.mjs'
import { eventRel } from '../lib/mods/clawd.mjs'
import { inboxDir, sendMessage, sendResultData, sendResultText } from '../lib/mods/sessions-data.mjs'
import { makeRepo, tempStore } from './helpers.mjs'

const MIN = 60_000
const HOUR = 60 * MIN
const NO_NATIVE = JSON.stringify({ claude: [], grok: [] })
const DASHBOARD = { agent: 'dashboard', id: null, title: null }

function setup(name = 'shop') {
  const s = tempStore()
  const cwd = makeRepo(name)
  const project = projectInfo(cwd)
  const now = Date.now()
  touchProjectMeta(s.store, project, now)
  return { ...s, env: { ...s.env, AGENT_MODS_NATIVE_HOMES: NO_NATIVE }, cwd, project, now }
}

const build = (t, extra = {}) => buildSnapshot(t.store, { now: t.now, env: t.env, ...extra })
const slash = (rel) => String(rel).replace(/\\/g, '/')

// A record as the sessions mod writes it: pid and home null, so liveness is the 30-minute heartbeat.
function recordFor(project, now, fields = {}) {
  const record = {
    v: 1,
    agent: 'codex',
    id: 'peer-0001',
    home: null,
    pid: null,
    cwd: project.cwd,
    worktreeKey: project.worktreeKey,
    repoKey: project.repoKey,
    projectId: project.projectId,
    startedAt: now - HOUR,
    beatAt: now,
    endedAt: null,
    state: 'working',
    waitingFor: null,
    turns: 3,
    turnStartedAt: now - 5 * MIN,
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
  return { ...record, key: sessionKey(record.agent, record.id) }
}

function writeRecord(t, fields = {}) {
  const record = recordFor(t.project, t.now, fields)
  t.store.writeJson(recordRel(record.key), record)
  return record
}

// Calls of target[name] per first argument while fn runs (fs.statSync, here: the modules under test
// call it through the same default export).
function counted(target, name, fn) {
  const real = target[name]
  const calls = new Map()
  target[name] = function (first, ...rest) {
    calls.set(String(first), (calls.get(String(first)) ?? 0) + 1)
    return real.call(this, first, ...rest)
  }
  try {
    fn()
  } finally {
    target[name] = real
  }
  return calls
}

// --- snapshot ----------------------------------------------------------------------------------------

test('snapshot: a hat file that cannot be read leaves only that row without a hat; every other row, count and total stays', () => {
  const t = setup()
  for (const id of ['a-0001', 'b-0001', 'c-0001']) writeRecord(t, { id, title: `Session ${id}` })
  t.store.writeJson('sessions/codex__a-0001/clawd.json', { hat: 'crown' })
  // A directory where the file belongs reads as EISDIR: a stand-in for a file another process holds
  // (EBUSY) or an ACL denies (EPERM).
  fs.mkdirSync(t.store.path('sessions', 'codex__b-0001', 'clawd.json'), { recursive: true })

  const snap = build(t)
  assert.deepEqual(Object.fromEntries(snap.sessions.map((s) => [s.id, s.hat])), { 'a-0001': 'crown', 'b-0001': null, 'c-0001': null })
  assert.deepEqual(snap.counts, { needsYou: 0, working: 3, done: 0, open: 0, running: 3 })
  assert.equal(snap.projects.find((p) => p.id === t.project.projectId)?.live, 3)
  assert.equal(snap.health.agents.find((a) => a.agent === 'codex').live, 3)
})

test('snapshot: a store file that does not parse is read once, not again every build, and again as soon as its stamp moves', () => {
  const t = setup()
  writeRecord(t, { id: 'good-0001', title: 'Good one' })
  // What an unclean shutdown can leave: an empty record, and a hat file cut off mid-write.
  const record = recordRel('codex__bad-00001')
  fs.writeFileSync(t.store.path(record), '')
  const hat = 'sessions/codex__good-0001/clawd.json'
  fs.mkdirSync(path.dirname(t.store.path(hat)), { recursive: true })
  fs.writeFileSync(t.store.path(hat), '{"hat": "cr')
  const reads = []
  const counting = { ...t.store, readJson: (rel, fallback) => (reads.push(slash(rel)), t.store.readJson(rel, fallback)) }
  const again = () => buildSnapshot(counting, { now: t.now, env: t.env })
  const broken = () => reads.filter((rel) => rel === record || rel === hat)

  assert.deepEqual(again().sessions.map((s) => [s.id, s.hat]), [['good-0001', null]])
  assert.deepEqual(broken(), [record, hat], 'each read once in the first build')
  reads.length = 0
  assert.deepEqual(again().sessions.map((s) => [s.id, s.hat]), [['good-0001', null]])
  assert.deepEqual(broken(), [], 'unchanged, so neither is read (or slept on) again')

  writeRecord(t, { id: 'bad-00001', title: 'Mended' })
  fs.writeFileSync(t.store.path(hat), '{"hat":"crown"}')
  const mended = again()
  assert.deepEqual(Object.fromEntries(mended.sessions.map((s) => [s.id, s.hat])), { 'bad-00001': null, 'good-0001': 'crown' })
})

test('snapshot: a record another process holds is tried once a build, and shows again on the first build after it is let go', () => {
  const t = setup()
  writeRecord(t, { id: 'held-0001', title: 'Held' })
  const file = t.store.path(recordRel('codex__held-0001'))
  const real = fs.readFileSync
  let held = true
  let opens = 0
  fs.readFileSync = function (target, ...rest) {
    if (String(target) === file) {
      opens++
      if (held) throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${file}'`), { code: 'EBUSY' })
    }
    return real.call(this, target, ...rest)
  }
  try {
    assert.deepEqual(build(t).sessions, [])
    assert.equal(opens, 2, "one readJson (its read and its one retry) for the whole build, not one for each of the three parts")
    held = false
    assert.deepEqual(build(t).sessions.map((s) => s.id), ['held-0001'], 'the failure was not remembered past its build')
  } finally {
    fs.readFileSync = real
  }
})

test('snapshot: a build stats each record file once, though three parts read every record', () => {
  const t = setup()
  for (let i = 0; i < 4; i++) writeRecord(t, { id: `peer-000${i}`, edits: { 'src/a.ts': t.now - MIN } })
  for (const label of ['cold', 'warm']) {
    const stats = counted(fs, 'statSync', () => build(t))
    const perRecord = [...stats].filter(([file]) => /[\\/]sessions[\\/][^\\/]+\.json$/.test(file)).map(([, n]) => n)
    assert.deepEqual(perRecord, [1, 1, 1, 1], label)
  }
})

test('snapshot: clashes, ideas, rules and decisions are capped like assumptions, newest kept; ideasCount is the whole shelf', () => {
  const t = setup()
  const files = Array.from({ length: 25 }, (_, i) => `src/f${String(i).padStart(2, '0')}.ts`)
  const edits = Object.fromEntries(files.map((file, i) => [file, t.now - (i + 1) * 1_000]))
  writeRecord(t, { agent: 'claude', id: 'clash-a01', edits })
  writeRecord(t, { agent: 'codex', id: 'clash-b01', edits })
  const ideas = Array.from({ length: 60 }, (_, i) => ({ id: `${t.now - (60 - i) * 1_000}-i${i}`, text: `Idea ${i}`, source: 'you', createdAt: t.now - (60 - i) * 1_000, status: 'open' }))
  ideas[57] = { ...ideas[57], status: 'taken', takenBy: { agent: 'claude', sessionKey: 'claude__x', at: t.now } }
  t.store.writeJson(projectFile(t.project, 'ideas.json'), { v: 1, ideas })
  const rules = Array.from({ length: 55 }, (_, i) => ({ id: i + 1, assumption: `guess ${i + 1}`, correction: `fix ${i + 1}`, by: 'user', at: t.now - (55 - i) * MIN }))
  t.store.writeJson(projectFile(t.project, 'assumptions.json'), { v: 1, lastId: 0, items: [], rules })
  const decisions = Array.from({ length: 55 }, (_, i) => ({ question: `Q${i + 1}?`, choice: `C${i + 1}`, at: t.now - (55 - i) * MIN, agent: 'claude', sessionKey: null }))
  t.store.writeJson(projectFile(t.project, 'design.json'), { v: 1, decisions })

  const snap = build(t)
  assert.deepEqual(snap.clashes.map((c) => c.file), files.slice(0, 20), 'the 20 newest clashes, newest first')
  const [p] = snap.projects
  assert.equal(p.ideasCount, 60)
  const newestOpen = Array.from({ length: 50 }, (_, i) => i + 10).filter((i) => i !== 57)
  assert.deepEqual(p.ideas.map((idea) => idea.text), [...newestOpen.map((i) => `Idea ${i}`), 'Idea 57'], 'the 50 newest, open first then taken')
  assert.equal(p.ideas.at(-1).status, 'taken')
  assert.deepEqual(p.rules.map((r) => r.id), Array.from({ length: 50 }, (_, i) => i + 6), 'the 50 newest rules, in file order')
  assert.deepEqual(p.decisions.map((d) => d.question), Array.from({ length: 50 }, (_, i) => `Q${i + 6}?`), 'the 50 newest decisions, in file order')

  const small = setup('small')
  writeRecord(small)
  assert.equal(build(small).projects[0].ideasCount, 0, 'a project with no shelf counts 0')
})

// --- send --------------------------------------------------------------------------------------------

test('send: an exact key reads that one record; the store is never scanned', () => {
  const t = setup()
  for (let i = 0; i < 40; i++) writeRecord(t, { id: `other-${String(i).padStart(4, '0')}`, title: `Other ${i}` })
  const peer = writeRecord(t)
  const reads = []
  const lists = []
  const counting = {
    ...t.store,
    readJson: (rel, fallback) => (reads.push(slash(rel)), t.store.readJson(rel, fallback)),
    list: (rel) => (lists.push(slash(rel)), t.store.list(rel)),
  }
  const sent = runAction(counting, { type: 'send', key: peer.key, text: 'hold off src/auth.ts' }, { now: t.now })
  assert.equal(sent.status, 200, sent.text)
  assert.deepEqual(reads, [recordRel(peer.key)])
  assert.deepEqual(lists, [])
  assert.equal(fs.readdirSync(inboxDir(t.store, peer.key)).length, 1)
})

test('send: the reply and the queued file are what the full scan of every record gave', () => {
  const project = projectInfo(makeRepo('twin'))
  const now = Date.now()
  const text = '  hold off src/auth.ts  '
  const inbox = (store, key) => {
    let names = []
    try {
      names = fs.readdirSync(inboxDir(store, key)).sort()
    } catch {}
    return names.map((name) => ({ at: name.split('-')[0], message: JSON.parse(fs.readFileSync(path.join(inboxDir(store, key), name), 'utf8')) }))
  }
  // Two stores holding the same records: one sends the dashboard's way, the other the way every
  // send went before (sendMessage scanning the whole store).
  const twins = (target, { keyless = false } = {}) =>
    [tempStore(), tempStore()].map((s) => {
      for (let i = 0; i < 6; i++) s.store.writeJson(recordRel(`codex__other-000${i}`), recordFor(project, now, { id: `other-000${i}`, title: `Other ${i}` }))
      s.store.writeJson(recordRel('claude__peer-0001'), recordFor(project, now, { agent: 'claude', title: 'Same id, other agent' }))
      const record = recordFor(project, now, target)
      const { key, ...rest } = record
      s.store.writeJson(recordRel(key), keyless ? rest : record)
      return s
    })
  const scenarios = [
    ['a live session', 'codex__peer-0001', {}, {}],
    ['an ended session', 'codex__peer-0001', { endedAt: now - MIN }, {}],
    ['a record written without its key', 'codex__peer-0001', {}, { keyless: true }],
    ['the same id under another agent', 'claude__peer-0001', {}, {}],
  ]
  for (const [name, key, target, options] of scenarios) {
    const [dashboard, scan] = twins(target, options)
    const before = sendMessage(scan.store, { to: key, text, from: DASHBOARD, now })
    const reply = runAction(dashboard.store, { type: 'send', key, text }, { now })
    assert.equal(reply.ok, before.status === 'queued', name)
    assert.equal(reply.text, sendResultText(before), name)
    if (reply.ok) assert.deepEqual(reply.data, sendResultData(before), name)
    assert.deepEqual(inbox(dashboard.store, key), inbox(scan.store, key), name)
  }
  const [one, all] = twins({})
  const record = one.store.readJson(recordRel('codex__peer-0001'), null)
  assert.deepEqual(
    sendMessage(one.store, { to: 'codex__peer-0001', text, from: DASHBOARD, now, candidates: [record] }),
    sendMessage(all.store, { to: 'codex__peer-0001', text, from: DASHBOARD, now }),
    'sendMessage with the one record as its candidates answers as the scan does',
  )
})

// --- activity ----------------------------------------------------------------------------------------

const NOON = new Date(2026, 9, 12, 12, 0, 0).getTime()
const MIDNIGHT = new Date(2026, 9, 12, 0, 0, 0).getTime()

const event = (t, label, extra = {}) => ({ v: 1, t, agent: 'codex', sid: 'codex__abc-123', pk: 'proj-12345678', project: 'proj', ev: 'tool.post', kind: 'edit', label, ok: true, ...extra })

function append(store, line) {
  fs.mkdirSync(store.path('events'), { recursive: true })
  fs.appendFileSync(store.path(eventRel(line.t)), `${JSON.stringify(line)}\n`)
}

const labels = (lines) => lines.map((line) => line.label)

test('activity: a clock stepped back across midnight sends no old line again, and passing midnight again sends no duplicate', () => {
  const { store } = tempStore()
  for (let i = 0; i < 500; i++) append(store, event(MIDNIGHT - 2_400_000 + i * 4_700, `old ${i}`))
  for (let i = 0; i < 50; i++) append(store, event(MIDNIGHT + i * 100, `new ${i}`))
  const feed = createActivity(store, { now: MIDNIGHT + 10_000 })
  assert.equal(feed.seed().length, 400)
  assert.deepEqual(feed.read(MIDNIGHT + 12_000), [])
  assert.deepEqual(labels(feed.read(MIDNIGHT - 5_000)), [], 'stepped back to 23:59:55: yesterday was sent already, or is past keepMs')
  assert.deepEqual(labels(feed.read(MIDNIGHT + 20_000)), [], 'past midnight again: today was sent already')
  append(store, event(MIDNIGHT + 21_000, 'fresh'))
  assert.deepEqual(labels(feed.read(MIDNIGHT + 22_000)), ['fresh'])
  const recent = feed.recent()
  assert.equal(new Set(recent.map((line) => JSON.stringify(line))).size, recent.length, 'recent() holds no line twice')
})

test("activity: at midnight the old day's last line and the new day's lines all come, once", () => {
  const { store } = tempStore()
  append(store, event(MIDNIGHT - 3_000, 'seeded'))
  const feed = createActivity(store, { now: MIDNIGHT - 2_000 })
  append(store, event(MIDNIGHT - 1_000, 'late in the old day'))
  for (let i = 0; i < 3; i++) append(store, event(MIDNIGHT + i * 100, `new day ${i}`))
  assert.deepEqual(labels(feed.read(MIDNIGHT + 1_000)), ['late in the old day', 'new day 0', 'new day 1', 'new day 2'])
  assert.deepEqual(feed.read(MIDNIGHT + 2_000), [])
})

test('activity: a line up to 2 s older than the newest one sent still comes; older ones and ones past keepMs do not', () => {
  const { store } = tempStore()
  append(store, event(NOON - 1_000, 'seeded'))
  const feed = createActivity(store, { now: NOON })
  append(store, event(NOON + 5_000, 'newest'))
  assert.deepEqual(labels(feed.read(NOON + 5_100)), ['newest'])
  // Hooks of several agents append slightly out of order, and two lines can share a millisecond.
  append(store, event(NOON + 3_500, 'late by 1.5 s'))
  append(store, event(NOON + 5_000, 'same millisecond', { agent: 'claude', sid: 'claude__other-1' }))
  append(store, event(NOON + 2_000, 'late by 3 s'))
  assert.deepEqual(labels(feed.read(NOON + 5_200)), ['late by 1.5 s', 'same millisecond'])
  append(store, event(NOON + 4_000, 'past keepMs'))
  assert.deepEqual(feed.read(NOON + 4_000 + KEEP_MS), [])
})
