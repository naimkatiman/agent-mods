// Fixes from the 2026-10-12 adversarial review of the dashboard server, its instance file and the
// `dashboard` command. Temp stores only. Servers run in this process with stand-in data modules,
// except the real snapshot build where the finding is about what that build cleans, and one plain
// node child that holds its event loop (the stand-in for a dashboard stuck in a long build). No
// browser opens and no real store or agent home is read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { makeCliContext, runCli } from '../lib/core/cli.mjs'
import { pidAlive, sleepSync } from '../lib/core/fsx.mjs'
import { recordRel } from '../lib/core/session-records.mjs'
import { sessionKey } from '../lib/core/store.mjs'
import { runDashboard } from '../lib/dashboard/commands.mjs'
import { HEALTH_APP, ensureToken, findRunning, probe, readInstance, stopInstance, writeInstance } from '../lib/dashboard/instance.mjs'
import { startDashboard } from '../lib/dashboard/server.mjs'
import sessions from '../lib/mods/sessions.mjs'
import { tempDir, tempStore } from './helpers.mjs'

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345'
const COOKIE = `amdash=${TOKEN}`
const NOW = Date.UTC(2026, 9, 12, 8, 0, 0)
const SHELLS = ['powershell', 'bash', 'cmd']
// A short probe for the direct instance calls; the command itself always uses the default one.
const quickProbe = (port) => probe(port, { timeoutMs: 300 })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(20)
  }
}

// Stand-ins for snapshot.mjs, actions.mjs and activity.mjs.
function fakes(extra = {}) {
  return {
    clock: () => NOW,
    intervalMs: 40,
    watch: false,
    build: () => ({ v: 1, n: 1, sessions: [] }),
    signature: (snapshot) => String(snapshot.n),
    act: () => ({ status: 200, ok: true, text: 'Done.' }),
    activity: () => ({ seed: () => [], read: () => [], recent: () => [] }),
    ...extra,
  }
}

async function start(t, extra = {}) {
  const { store, env } = tempStore()
  const server = await startDashboard({ store, env, port: 0, token: TOKEN, ...fakes(extra) })
  t.after(() => server.close())
  return { server, store, env }
}

function get(server, target) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: server.port, path: target, agent: false, setHost: false, headers: { host: `127.0.0.1:${server.port}`, cookie: COOKIE } },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode, body: /json/.test(res.headers['content-type'] ?? '') ? JSON.parse(text) : text })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

// A small EventSource: frames as { event, data, at }, data parsed, at the arrival time in ms.
function openEvents(server) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: server.port, path: '/events', agent: false, setHost: false, headers: { host: `127.0.0.1:${server.port}`, cookie: COOKIE } },
      (res) => {
        const frames = []
        let buffer = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          buffer += chunk
          let at
          while ((at = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, at)
            buffer = buffer.slice(at + 2)
            const frame = { at: performance.now() }
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) frame.event = line.slice(7)
              else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6))
            }
            if (frame.event) frames.push(frame)
          }
        })
        res.on('error', () => {})
        resolve({ frames, of: (name) => frames.filter((f) => f.event === name), close: () => req.destroy() })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

// A port nothing listens on (bound once by the OS, then let go).
async function freePort() {
  const server = http.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

function bindable(port) {
  return new Promise((resolve) => {
    const server = http.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

// A plain node server that holds its event loop from the moment it listens, the way a long build or
// an action holds the dashboard's: the OS still accepts connections, and nothing answers them.
// Atomics.wait blocks without spinning a core. The child is killed after the test.
const HELD_SERVER = `
const http = require('node:http')
const fs = require('node:fs')
const server = http.createServer((req, res) => res.end('{}'))
server.listen(0, '127.0.0.1', () => {
  fs.writeSync(1, server.address().port + '\\n')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
})
`

async function heldServer(t) {
  const child = spawn(process.execPath, ['-e', HELD_SERVER], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  t.after(() => child.kill())
  const exited = new Promise((resolve) => child.once('exit', resolve))
  const port = await new Promise((resolve, reject) => {
    let text = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      text += chunk
      if (text.includes('\n')) resolve(Number(text.trim()))
    })
    exited.then((code) => reject(new Error(`the held server exited (${code}) before it listened`)))
  })
  return { pid: child.pid, port, exited }
}

function sink() {
  const io = { out: '', err: '' }
  io.stdout = { write: (s) => ((io.out += s), true) }
  io.stderr = { write: (s) => ((io.err += s), true) }
  return io
}

const noSpawn = () => {
  throw new Error('a test tried to start a server process')
}

// The command with its test seams: a spawner that refuses unless one is given.
function dashRun(env, argv, deps = {}) {
  const io = sink()
  const c = makeCliContext({ argv, env, stdout: io.stdout, stderr: io.stderr })
  return { io, done: runDashboard(c, { spawner: noSpawn, ...deps }) }
}

async function dash(env, argv, deps) {
  const run = dashRun(env, argv, deps)
  const code = await run.done
  return { code, out: run.io.out, err: run.io.err }
}

// What Ctrl+C runs, called directly: a real SIGINT would also reach the test runner's own handler.
function pressCtrlC(before) {
  for (const fn of process.listeners('SIGINT')) if (!before.includes(fn)) fn('SIGINT')
}

// The exit code of a --foreground run that should refuse to serve. One still serving after `ms`
// gets Ctrl+C and reads as 'still serving', so the test fails instead of hanging.
async function refused(run, before, ms = 8000) {
  let timer
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve('still serving'), ms)
  })
  const first = await Promise.race([run.done, late])
  clearTimeout(timer)
  if (first === 'still serving') {
    pressCtrlC(before)
    await run.done
  }
  return { code: first, out: run.io.out, err: run.io.err }
}

// ---------------------------------------------------------------- busy-loop-reads-as-dead

test('busy: a server that took the connection but has not answered is busy; only a connection that fails reads as gone', async (t) => {
  const held = await heldServer(t)
  const started = Date.now()
  assert.equal(await quickProbe(held.port), 'busy')
  assert.ok(Date.now() - started < 1500, 'gives up at its timeout')
  assert.equal(await quickProbe(await freePort()), null, 'nothing listening')
})

test('busy: findRunning, a plain start and --foreground all read a busy dashboard as running, and start nothing over it', async (t) => {
  const { store, env } = tempStore()
  const quiet = { ...env, AGENT_MODS_NO_BROWSER: '1' }
  const held = await heldServer(t)
  writeInstance(store, { pid: held.pid, port: held.port, startedAt: NOW })
  const record = readInstance(store)
  assert.deepEqual(await findRunning(store, { probeFn: quickProbe }), { ...record, busy: true, clients: null })

  const spawned = []
  const spawner = (command, args) => {
    spawned.push(args)
    const child = new EventEmitter()
    child.unref = () => {}
    setTimeout(() => child.emit('exit', 1), 20)
    return child
  }
  const plain = await dash(quiet, ['--no-open', '--json'], { spawner })
  assert.equal(plain.code, 0, plain.err)
  assert.deepEqual(spawned, [], 'no second server is started over a busy one')
  assert.equal(JSON.parse(plain.out).pid, held.pid, 'the link is the busy server')
  assert.equal(JSON.parse(plain.out).started, false)

  const before = process.listeners('SIGINT')
  const fg = await refused(dashRun(quiet, ['--foreground', '--port', '0', '--no-open'], { server: fakes() }), before)
  assert.equal(fg.code, 1, '--foreground refuses to start beside a busy dashboard')
  assert.match(fg.err, /already running/)
  assert.deepEqual(readInstance(store), record, 'and the busy server keeps its record')
})

test('busy: stop kills a busy dashboard, then removes its record once the process is gone', async (t) => {
  const { store } = tempStore()
  const held = await heldServer(t)
  writeInstance(store, { pid: held.pid, port: held.port, startedAt: NOW })
  const result = await stopInstance(store, { probeFn: quickProbe })
  assert.deepEqual(result, { status: 'stopped', pid: held.pid })
  await held.exited
  assert.equal(pidAlive(held.pid), false, 'the busy server is really gone')
  assert.equal(readInstance(store), null)
})

test('busy: a busy dashboard that will not die keeps its record, and stop reports it stuck (exit 1)', async () => {
  const { store } = tempStore()
  writeInstance(store, { pid: 4242, port: 5555, startedAt: NOW })
  const killed = []
  const result = await stopInstance(store, { alive: () => true, kill: (pid) => killed.push(pid), probeFn: async () => 'busy', waitMs: 200 })
  assert.deepEqual(result, { status: 'stuck', pid: 4242 })
  assert.deepEqual(killed, [4242], 'a busy server is killed, not forgotten')
  assert.deepEqual(readInstance(store), { v: 1, pid: 4242, port: 5555, startedAt: NOW }, 'still on record')
})

// ---------------------------------------------------------------- build-gap-from-start

test('build gap: a build slower than the tick is always followed by at least 300 ms of idle loop', async (t) => {
  const spans = []
  const build = () => {
    const begin = performance.now()
    sleepSync(350)
    spans.push([begin, performance.now()])
    return { v: 1, n: 1 }
  }
  const { server } = await start(t, { build, intervalMs: 100 })
  const stream = await openEvents(server)
  t.after(() => stream.close())
  await waitFor(() => spans.length >= 5, 10_000)
  stream.close()
  const gaps = spans.slice(1).map(([begin], i) => begin - spans[i][1])
  assert.ok(Math.min(...gaps) >= 290, `idle time between builds: ${gaps.map(Math.round).join(', ')} ms`)
})

// ---------------------------------------------------------------- sse-tab-cap

test('tabs: /healthz also says how many pages hold an event stream, as a bare number', async (t) => {
  const { server } = await start(t)
  const health = async () => (await get(server, '/healthz')).body
  assert.deepEqual(await health(), { app: HEALTH_APP, v: 1, pid: process.pid, port: server.port, clients: 0 })
  const a = await openEvents(server)
  const b = await openEvents(server)
  t.after(() => a.close())
  t.after(() => b.close())
  await waitFor(() => server.clients() === 2)
  assert.equal((await health()).clients, 2)
  assert.equal((await quickProbe(server.port)).clients, 2, 'the probe reads it')
  a.close()
  await waitFor(() => server.clients() === 1)
  assert.equal((await health()).clients, 1)
})

test('tabs: a dashboard already open in a tab is pointed at, not opened again; --open forces a tab; no page opens one', async (t) => {
  const { server, store, env } = await start(t)
  const quiet = { ...env, AGENT_MODS_NO_BROWSER: '1' }
  writeInstance(store, { pid: process.pid, port: server.port, startedAt: NOW })
  const opened = []
  const browser = (url) => {
    opened.push(url)
    return true
  }
  const url = `http://127.0.0.1:${server.port}/?t=${ensureToken(store)}`

  const none = await dash(quiet, ['--json'], { browser })
  assert.equal(none.code, 0, none.err)
  assert.deepEqual(JSON.parse(none.out), { url, pid: process.pid, port: server.port, started: false, opened: true, alreadyOpen: false })
  assert.deepEqual(opened, [url], 'with no page open, the browser opens as before')

  const page = await openEvents(server)
  t.after(() => page.close())
  await waitFor(() => server.clients() === 1)
  const json = await dash(quiet, ['--json'], { browser })
  assert.deepEqual(JSON.parse(json.out), { url, pid: process.pid, port: server.port, started: false, opened: false, alreadyOpen: true })
  const text = await dash(quiet, [], { browser })
  assert.equal(text.code, 0)
  assert.match(text.out, /already open in a browser tab/)
  assert.ok(text.out.split('\n').includes(url), 'the link is still printed on a line of its own')
  assert.deepEqual(opened, [url], 'no second tab for a page that is open')

  const forced = await dash(quiet, ['--open', '--json'], { browser })
  assert.equal(JSON.parse(forced.out).opened, true)
  assert.deepEqual(opened, [url, url], '--open opens another tab anyway')
  page.close()
  await waitFor(() => server.clients() === 0)
  await dash(quiet, ['--no-open'], { browser })
  assert.equal(opened.length, 2, '--no-open never opens one')
})

// ---------------------------------------------------------------- port-fallback-race-orphan-dashboard

// startDashboard reads its clock once it has bound and before it returns, which is exactly the
// window where a second racer records itself: the hook writes that racer's record (a live pid that
// is not this process) the first time the clock is read.
function racerAfterBind(store, record) {
  let raced = false
  return () => {
    if (!raced) {
      raced = true
      writeInstance(store, record)
    }
    return NOW
  }
}

test('race: a server that binds while another dashboard records itself closes and exits as already running', async () => {
  const { store, env } = tempStore()
  const other = { pid: process.ppid, port: await freePort(), startedAt: NOW }
  const asked = await freePort()
  const before = process.listeners('SIGINT')
  const run = dashRun({ ...env, AGENT_MODS_NO_BROWSER: '1' }, ['--foreground', '--port', String(asked), '--no-open'], { server: fakes({ clock: racerAfterBind(store, other) }) })
  const r = await refused(run, before)
  assert.equal(r.code, 1, r.out)
  assert.match(r.err, /already running/)
  assert.deepEqual(readInstance(store), { v: 1, ...other }, 'only the first is on record')
  assert.ok(await bindable(asked), 'and the server that lost has let its port go')
})

test('race: on the fallback port too, the check-and-write keeps one dashboard on record and the other exits', async (t) => {
  const { store, env } = tempStore()
  const blocker = http.createServer()
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => blocker.close(resolve)))
  const other = { pid: process.ppid, port: await freePort(), startedAt: NOW }
  const before = process.listeners('SIGINT')
  const run = dashRun({ ...env, AGENT_MODS_NO_BROWSER: '1' }, ['--foreground', '--port', String(blocker.address().port), '--no-open'], {
    server: fakes({ clock: racerAfterBind(store, other) }),
  })
  const r = await refused(run, before)
  assert.equal(r.code, 1, r.out)
  assert.match(r.err, /already running/)
  assert.deepEqual(readInstance(store), { v: 1, ...other })
})

// Not a reproduction (this passed before the fix): the guard that the check-and-write does not
// obey a stale file. Windows reuses pids, so a record left by a killed server can name a live
// process that is no dashboard at all; the start has already probed it and found nothing there.
test('race: a stale record whose pid now belongs to some other process is replaced, not obeyed', async () => {
  const { store, env } = tempStore()
  writeInstance(store, { pid: process.ppid, port: await freePort(), startedAt: NOW })
  const before = process.listeners('SIGINT')
  const run = dashRun({ ...env, AGENT_MODS_NO_BROWSER: '1' }, ['--foreground', '--port', '0', '--no-open'], { server: fakes() })
  try {
    const mine = await waitFor(() => readInstance(store)?.pid === process.pid && readInstance(store), 8000)
    assert.ok(mine.port > 0)
  } finally {
    pressCtrlC(before)
  }
  assert.equal(await run.done, 0)
  assert.equal(readInstance(store), null)
})

// ---------------------------------------------------------------- resume-uses-sanitized-values

// Folder names the snapshot cleans for display: U+0085 (a C1 control, what a cp1252 apostrophe read
// as Latin-1 becomes) and U+202E (a bidi override). Both are legal in NTFS names.
const FOLDERS = { plain: 'd:/work/shop', c1: 'd:/work/odd\u0085name', bidi: 'd:/work/report\u202Eexe.txt' }

function writeRecord(store, { agent, id, cwd, home = null }) {
  const key = sessionKey(agent, id)
  store.writeJson(recordRel(key), { v: 1, agent, id, key, home, cwd, startedAt: Date.now() - 60_000, beatAt: Date.now(), state: 'idle', turns: 1, lastPrompt: 'fix it', files: [], edits: {} })
  return key
}

async function cliResume(env, id, shell) {
  const io = sink()
  const code = await runCli({ argv: ['sessions', 'resume', id, '--shell', shell, '--json'], env, stdout: io.stdout, stderr: io.stderr, mods: [sessions] })
  assert.equal(code, 0, io.err)
  return JSON.parse(io.out).command
}

// The page's answer for every shell next to `agent-mods sessions resume`'s: the same command, or a
// 409 where the CLI has none to give.
async function samePageAndCli(server, env, key, id) {
  for (const shell of SHELLS) {
    const expected = await cliResume(env, id, shell)
    const page = await get(server, `/api/resume?key=${encodeURIComponent(key)}&shell=${shell}`)
    if (expected === null) assert.equal(page.status, 409, `${id} ${shell}: the CLI has no safe command, the page said ${JSON.stringify(page.body)}`)
    else {
      assert.equal(page.status, 200, `${id} ${shell}`)
      assert.equal(page.body.command, expected, `${id} ${shell}`)
    }
  }
}

// The real snapshot build (it is what cleans the values), with stand-ins for the rest. The agents'
// own registries are read only from `nativeHomes`, never from this user's homes.
async function realBuild(t, nativeHomes) {
  const { store, env: base } = tempStore()
  const env = { ...base, AGENT_MODS_NATIVE_HOMES: JSON.stringify(nativeHomes) }
  const { act, activity } = fakes()
  const server = await startDashboard({ store, env, port: 0, token: TOKEN, watch: false, act, activity })
  t.after(() => server.close())
  return { server, store, env }
}

test('resume: the page builds the command from the raw record, so it gives exactly what `agent-mods sessions resume` gives', async (t) => {
  const { server, store, env } = await realBuild(t, { claude: [], grok: [] })
  const home = tempDir('am-claude-home-')
  const keys = Object.fromEntries(Object.entries(FOLDERS).map(([name, cwd]) => [name, writeRecord(store, { agent: 'claude', id: `${name}-0001`, cwd, home })]))
  const shown = (await get(server, '/api/snapshot')).body.sessions
  assert.equal(shown.find((s) => s.key === keys.c1)?.cwd, 'd:/work/oddname', 'the page shows the cleaned folder')
  for (const name of Object.keys(FOLDERS)) await samePageAndCli(server, env, keys[name], `${name}-0001`)
  const bidi = await get(server, `/api/resume?key=${keys.bidi}&shell=powershell`)
  assert.ok(bidi.body.command.includes(FOLDERS.bidi), 'the real folder, not the one the page displays')
})

test('resume: a session with no record resumes from its raw registry entry, the way the CLI does', async (t) => {
  const home = tempDir('am-claude-home-')
  fs.mkdirSync(path.join(home, 'sessions'))
  const entry = (pid, sessionId, cwd) => fs.writeFileSync(path.join(home, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd, status: 'idle', updatedAt: Date.now() }))
  entry(process.pid, 'native-c1-0001', FOLDERS.c1)
  entry(process.ppid, 'native-ok-0001', FOLDERS.plain)
  const { server, env } = await realBuild(t, { claude: [home], grok: [] })
  const shown = (await get(server, '/api/snapshot')).body.sessions
  for (const id of ['native-c1-0001', 'native-ok-0001']) {
    const row = shown.find((s) => s.id === id)
    assert.equal(row?.native, true, `${id} is a native-only row`)
    await samePageAndCli(server, env, row.key, id)
  }
})

// ---------------------------------------------------------------- whole-snapshot-every-heartbeat

test('pushes: a store that changes on every build reaches a page at most once a second, the last change still arrives, and activity keeps its pace', async (t) => {
  let n = 0
  let frozen = false
  const { server } = await start(t, {
    build: () => ({ v: 1, n: frozen ? n : ++n }),
    activity: () => ({ seed: () => [], recent: () => [], read: () => [{ t: NOW, ev: 'tick' }] }),
  })
  const stream = await openEvents(server)
  t.after(() => stream.close())
  await sleep(2600)
  frozen = true
  await sleep(1300)
  const snapshots = stream.of('snapshot')
  // The first frame is the page's own at connect; every later one is a push to all pages.
  const pushes = snapshots.slice(1)
  const gaps = pushes.slice(1).map((f, i) => f.at - pushes[i].at)
  assert.ok(gaps.every((gap) => gap >= 900), `gaps between pushes: ${gaps.map(Math.round).join(', ')} ms`)
  assert.ok(snapshots.length <= 6, `${snapshots.length} snapshots in 4 s`)
  assert.equal(snapshots.at(-1).data.n, n, 'the newest snapshot reached the page')
  assert.ok(stream.of('activity').length >= 30, `activity frames: ${stream.of('activity').length}`)
})
