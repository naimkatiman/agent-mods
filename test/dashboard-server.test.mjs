// The dashboard's server, its instance file and the `dashboard` command, all in this process:
// startDashboard on port 0 with a fake build/signature/act/activity and no watchers, probed with
// node:http (agent: false and an explicit Host header, which fetch cannot send). Nothing here spawns
// a server process, opens a browser or touches the real store.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeCliContext, parseArgs, runCli } from '../lib/core/cli.mjs'
import { CLI_SCRIPT } from '../lib/core/paths.mjs'
import { DASHBOARD_COMMANDS, runDashboard } from '../lib/dashboard/commands.mjs'
import {
  HEALTH_APP,
  ensureToken,
  findRunning,
  probe,
  readInstance,
  readToken,
  removeInstance,
  startDetached,
  stopInstance,
  writeInstance,
} from '../lib/dashboard/instance.mjs'
import { startDashboard } from '../lib/dashboard/server.mjs'
import { resumeCommand } from '../lib/mods/sessions-text.mjs'
import { tempDir, tempStore } from './helpers.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345'
const COOKIE = `amdash=${TOKEN}`
const NOW = Date.UTC(2026, 9, 12, 8, 0, 0)
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

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

// Stand-ins for snapshot.mjs, actions.mjs and activity.mjs: `data` is what they read and record.
function fakes() {
  const data = {
    n: 1,
    builds: 0,
    sessions: [],
    lines: [{ t: NOW, agent: 'codex', key: 'codex__s1', ev: 'prompt.submit' }],
    incoming: [],
    acts: [],
    result: { status: 200, ok: true, text: 'Done.' },
  }
  const options = {
    clock: () => NOW,
    intervalMs: 40,
    watch: false,
    build: (store, { now, server }) => {
      data.builds += 1
      return { v: 1, at: now, n: data.n, sessions: data.sessions, server }
    },
    signature: (snapshot) => String(snapshot.n),
    act: (store, body, ctx) => {
      data.acts.push({ store, body, ctx })
      return data.result
    },
    activity: () => ({ seed: () => data.lines, read: () => data.incoming.splice(0), recent: () => data.lines }),
  }
  return { data, options }
}

async function start(t, extra = {}) {
  const { store, env } = tempStore()
  const { data, options } = fakes()
  const server = await startDashboard({ store, env, port: 0, token: TOKEN, ...options, ...extra })
  t.after(() => server.close())
  return { server, store, env, data }
}

function fakePublic(skip = []) {
  const dir = tempDir('am-public-')
  const files = {
    'index.html': '<!doctype html><title>test page</title>',
    'app.css': 'body { margin: 0 }',
    'app.js': 'export const app = 1',
    'pets.js': 'export const pets = 1',
    'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  }
  for (const [name, text] of Object.entries(files)) if (!skip.includes(name)) fs.writeFileSync(path.join(dir, name), text)
  return dir
}

// host: undefined sends the right one, null sends none. chunked: the body goes out in two writes with
// no content-length, so the server has to count while it streams.
function request(server, target, { method = 'GET', host, headers = {}, body, chunked = false } = {}) {
  const hostHeader = host === null ? {} : { host: host ?? `127.0.0.1:${server.port}` }
  return new Promise((resolve, reject) => {
    let answered = false
    const req = http.request(
      { hostname: '127.0.0.1', port: server.port, path: target, method, agent: false, setHost: false, headers: { ...hostHeader, ...headers } },
      (res) => {
        answered = true
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const bytes = Buffer.concat(chunks)
          resolve({ status: res.statusCode, headers: res.headers, text: bytes.toString('utf8'), bytes: bytes.length })
        })
      },
    )
    // An early 413 can close the socket while the body is still going out; the reply is what counts.
    req.on('error', (err) => {
      if (!answered) reject(err)
    })
    if (chunked && body) {
      req.write(body.slice(0, body.length >> 1))
      req.end(body.slice(body.length >> 1))
    } else req.end(body)
  })
}

// A small EventSource: frames as { event, data } with data parsed, ':' lines as { comment }.
function openEvents(server, headers = { cookie: COOKIE }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: server.port, path: '/events', agent: false, setHost: false, headers: { host: `127.0.0.1:${server.port}`, ...headers } },
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
            const frame = {}
            for (const line of block.split('\n')) {
              if (line.startsWith(':')) frame.comment = line.slice(1).trim()
              else if (line.startsWith('event: ')) frame.event = line.slice(7)
              else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6))
            }
            frames.push(frame)
          }
        })
        res.on('error', () => {})
        const ended = new Promise((done) => res.on('close', done))
        resolve({
          status: res.statusCode,
          headers: res.headers,
          frames,
          ended,
          of: (name) => frames.filter((f) => f.event === name).map((f) => f.data),
          close: () => req.destroy(),
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

// ---------------------------------------------------------------- server: who gets in

test('server: every request must name 127.0.0.1:<port> in Host, or it gets a 403', async (t) => {
  const { server } = await start(t)
  const hosts = [`localhost:${server.port}`, '127.0.0.1', `127.0.0.1:${server.port + 1}`, `rebound.example:${server.port}`, null]
  for (const host of hosts) {
    for (const target of ['/', `/?t=${TOKEN}`, '/healthz', '/events', '/api/snapshot']) {
      const r = await request(server, target, { host, headers: { cookie: COOKIE } })
      assert.equal(r.status, 403, `${host} ${target}`)
    }
  }
})

test('server: no cookie or a wrong one gets the 401 page that says to run agent-mods dashboard', async (t) => {
  const { server } = await start(t, { publicDir: fakePublic() })
  for (const cookie of [undefined, 'amdash=nope', `other=${TOKEN}`, `amdash=${TOKEN}x`, `amdash=${TOKEN.slice(1)}`]) {
    for (const target of ['/', '/app.js', '/events', '/api/snapshot', '/api/resume?key=a__b', '/nope']) {
      const r = await request(server, target, { headers: cookie ? { cookie } : {} })
      assert.equal(r.status, 401, `${cookie} ${target}`)
    }
  }
  const page = await request(server, '/')
  assert.match(page.headers['content-type'], /^text\/html/)
  assert.match(page.text, /agent-mods dashboard/)
  assert.equal(page.headers['content-security-policy'], CSP)
  const ok = await request(server, '/', { headers: { cookie: `theme=dark; ${COOKIE}` } })
  assert.equal(ok.status, 200, 'the token cookie is found among others')
})

test('server: /?t=<token> trades the token for an HttpOnly SameSite=Strict cookie, then 303s to /', async (t) => {
  const { server } = await start(t)
  const r = await request(server, `/?t=${TOKEN}`)
  assert.equal(r.status, 303)
  assert.equal(r.headers.location, '/')
  assert.deepEqual(r.headers['set-cookie'], [`amdash=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`])
  for (const target of ['/?t=nope', `/?t=${TOKEN}x`, '/?t=']) {
    const wrong = await request(server, target)
    assert.equal(wrong.status, 401, target)
    assert.equal(wrong.headers['set-cookie'], undefined, target)
  }
})

test('server: the page carries the CSP; every answer carries the safety headers and no CORS header', async (t) => {
  const { server } = await start(t, { publicDir: fakePublic() })
  const page = await request(server, '/', { headers: { cookie: COOKIE } })
  assert.equal(page.status, 200)
  assert.equal(page.headers['content-security-policy'], CSP)
  const answers = [
    page,
    await request(server, '/app.js', { headers: { cookie: COOKIE } }),
    await request(server, '/healthz'),
    await request(server, '/nope', { headers: { cookie: COOKIE } }),
    await request(server, '/'),
    await request(server, '/', { host: 'evil.example' }),
    await request(server, '/api/action', { method: 'POST', headers: { cookie: COOKIE } }),
  ]
  for (const r of answers) {
    assert.equal(r.headers['cache-control'], 'no-store')
    assert.equal(r.headers['x-content-type-options'], 'nosniff')
    assert.equal(r.headers['referrer-policy'], 'no-referrer')
    assert.equal(r.headers['cross-origin-opener-policy'], 'same-origin')
    assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin')
    assert.deepEqual(Object.keys(r.headers).filter((h) => h.startsWith('access-control-')), [])
  }
  assert.equal(answers[1].headers['content-security-policy'], undefined, 'the CSP rides on HTML only')
})

// ---------------------------------------------------------------- server: static files

test('server: a fixed allowlist of files, each with its own type; nothing else on disk is reachable', async (t) => {
  const pub = fakePublic()
  const { server } = await start(t, { publicDir: pub })
  const get = (target) => request(server, target, { headers: { cookie: COOKIE } })
  const served = [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/app.css', 'app.css', 'text/css; charset=utf-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/pets.js', 'pets.js', 'text/javascript; charset=utf-8'],
    ['/favicon.svg', 'favicon.svg', 'image/svg+xml'],
  ]
  for (const [target, name, type] of served) {
    const r = await get(target)
    assert.equal(r.status, 200, target)
    assert.equal(r.headers['content-type'], type, target)
    assert.equal(r.text, fs.readFileSync(path.join(pub, name), 'utf8'), target)
  }
  const sprite = await get('/clawd-sprite.mjs')
  assert.equal(sprite.status, 200)
  assert.equal(sprite.headers['content-type'], 'text/javascript; charset=utf-8')
  assert.equal(sprite.text, fs.readFileSync(path.join(ROOT, 'lib', 'mods', 'clawd-sprite.mjs'), 'utf8'))
  if (fs.existsSync(path.join(ROOT, 'lib', 'mods', 'clawd-world.mjs'))) {
    const world = await get('/clawd-world.mjs')
    assert.equal(world.status, 200)
    assert.equal(world.headers['content-type'], 'text/javascript; charset=utf-8')
  }
  const wav = await get('/done.wav')
  assert.equal(wav.status, 200)
  assert.equal(wav.headers['content-type'], 'audio/wav')
  assert.equal(wav.bytes, fs.statSync(path.join(ROOT, 'assets', 'done.wav')).size)
  const refused = [
    '/../package.json',
    '/%2e%2e/package.json',
    '/%2E%2E/%2E%2E/package.json',
    '/..%2fpackage.json',
    '/app.js.map',
    '/lib/core/store.mjs',
    '/lib/mods/clawd-sprite.mjs',
    '/assets/done.wav',
    '/public/app.js',
    '//app.js',
    '/app.js/',
    '/APP.JS',
  ]
  for (const target of refused) {
    const r = await get(target)
    assert.equal(r.status, 404, target)
    assert.ok(!r.text.includes('agent-mods'), `${target} leaked a file`)
  }
})

test('server: an allowlisted file that is missing is a 404, and the query string never picks a file', async (t) => {
  const { server } = await start(t, { publicDir: fakePublic(['pets.js']) })
  assert.equal((await request(server, '/pets.js', { headers: { cookie: COOKIE } })).status, 404)
  const withQuery = await request(server, '/app.js?file=../package.json', { headers: { cookie: COOKIE } })
  assert.equal(withQuery.status, 200)
  assert.equal(withQuery.text, 'export const app = 1')
})

test('the shipped page loads app.css and app.js and has no inline script, style or handler (the CSP blocks them)', () => {
  const dir = path.join(ROOT, 'lib', 'dashboard', 'public')
  for (const name of ['index.html', 'app.css', 'app.js', 'pets.js', 'favicon.svg']) assert.ok(fs.existsSync(path.join(dir, name)), name)
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
  assert.match(html, /href=["']?(\.\/)?app\.css["'\s>]/)
  assert.match(html, /<script[^>]*src=["']?(\.\/)?app\.js["'\s>]/)
  assert.ok(!/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline script')
  assert.ok(!/<style\b/i.test(html) && !/\sstyle=/i.test(html), 'no inline style')
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline event handler')
})

// ---------------------------------------------------------------- server: actions

test('server: POST /api/action needs the cookie, the exact Origin, JSON and at most 16 KB; the action status passes through', async (t) => {
  const { server, store, env, data } = await start(t)
  const origin = `http://127.0.0.1:${server.port}`
  const body = '{"type":"notify","enabled":true}'
  const post = (headers, text = body, opts = {}) =>
    request(server, '/api/action', { method: 'POST', headers: { cookie: COOKIE, 'content-type': 'application/json', ...headers }, body: text, ...opts })
  assert.equal((await post({})).status, 403, 'no Origin')
  assert.equal((await post({ origin: 'http://127.0.0.1:1' })).status, 403, 'a page on another port')
  assert.equal((await post({ origin: `http://localhost:${server.port}` })).status, 403, 'localhost')
  assert.equal((await post({ origin: `${origin}/` })).status, 403, 'not exactly the origin')
  assert.equal((await post({ origin: 'null' })).status, 403, 'an opaque origin')
  assert.equal((await post({ origin, cookie: 'amdash=nope' })).status, 401, 'a wrong cookie')
  assert.equal((await post({ origin, 'content-type': 'text/plain' })).status, 415)
  assert.equal((await post({ origin, 'content-type': 'application/x-www-form-urlencoded' })).status, 415)
  const big = JSON.stringify({ type: 'send', key: 'a__b', text: 'x'.repeat(16 * 1024) })
  assert.equal((await post({ origin }, big)).status, 413, 'declared too big')
  assert.equal((await post({ origin }, big, { chunked: true })).status, 413, 'streamed too big')
  assert.equal((await post({ origin }, '{"type":')).status, 400)
  assert.equal((await post({ origin }, '[1]')).status, 400, 'not an object')
  assert.equal((await post({ origin }, '')).status, 400, 'empty')
  assert.equal(data.acts.length, 0, 'nothing refused reached the action')

  data.result = { status: 409, ok: false, text: "This project's folder is gone" }
  const r = await post({ origin, 'content-type': 'application/json; charset=utf-8' })
  assert.equal(r.status, 409)
  assert.deepEqual(JSON.parse(r.text), data.result)
  assert.match(r.headers['content-type'], /^application\/json/)
  assert.equal(data.acts.length, 1)
  assert.deepEqual(data.acts[0].body, { type: 'notify', enabled: true })
  assert.equal(data.acts[0].store, store)
  assert.deepEqual(data.acts[0].ctx, { now: NOW, env })

  data.result = { status: 200, ok: true, text: 'Sent.' }
  const fits = JSON.stringify({ type: 'send', key: 'a__b', text: 'y'.repeat(16 * 1024 - 60) })
  assert.ok(Buffer.byteLength(fits) <= 16 * 1024)
  assert.equal((await post({ origin }, fits, { chunked: true })).status, 200, 'just under the cap is fine')
  assert.equal((await request(server, '/api/action', { headers: { cookie: COOKIE } })).status, 405)
})

test('server: an action that throws is a 500 and an error log line, never a crash', async (t) => {
  const { server, store } = await start(t, {
    act: () => {
      throw new Error('boom')
    },
  })
  const r = await request(server, '/api/action', {
    method: 'POST',
    headers: { cookie: COOKIE, origin: `http://127.0.0.1:${server.port}`, 'content-type': 'application/json' },
    body: '{"type":"notify","enabled":false}',
  })
  assert.equal(r.status, 500)
  assert.equal(JSON.parse(r.text).ok, false)
  assert.match(fs.readFileSync(store.path('logs', 'errors.log'), 'utf8'), /dashboard: action: Error: boom/)
  assert.equal((await request(server, '/healthz')).status, 200, 'still serving')
})

// ---------------------------------------------------------------- server: live data

test('server: /events sends the snapshot and recent activity at once, then a snapshot only when its signature changes', async (t) => {
  const { server, data } = await start(t)
  const stream = await openEvents(server)
  t.after(() => stream.close())
  assert.equal(stream.status, 200)
  assert.equal(stream.headers['content-type'], 'text/event-stream; charset=utf-8')
  await waitFor(() => stream.of('activity').length === 1)
  assert.deepEqual(stream.frames.slice(0, 2).map((f) => f.event), ['snapshot', 'activity'])
  assert.equal(stream.of('snapshot')[0].n, 1)
  assert.deepEqual(stream.of('activity')[0], data.lines)

  const builds = data.builds
  await waitFor(() => data.builds >= builds + 3)
  assert.equal(stream.of('snapshot').length, 1, 'rebuilding with an unchanged signature pushes nothing')
  data.n = 2
  await waitFor(() => stream.of('snapshot').length === 2)
  assert.equal(stream.of('snapshot')[1].n, 2)

  const line = { t: NOW + 1, agent: 'claude', key: 'claude__s2', ev: 'turn.stop' }
  data.incoming.push(line)
  await waitFor(() => stream.of('activity').length === 2)
  assert.deepEqual(stream.of('activity')[1], [line], 'only the new lines')
  assert.equal(server.clients(), 1)
})

test('server: two pages share one build per tick, and a late page gets the current snapshot at once', async (t) => {
  const { server, data } = await start(t)
  const a = await openEvents(server)
  t.after(() => a.close())
  await waitFor(() => a.of('snapshot').length === 1)
  data.n = 7
  await waitFor(() => a.of('snapshot').length === 2)
  const builds = data.builds
  const b = await openEvents(server)
  t.after(() => b.close())
  await waitFor(() => b.of('activity').length === 1)
  assert.equal(b.of('snapshot')[0].n, 7)
  assert.ok(data.builds - builds <= 1, 'a second page does not cost a build of its own')
  assert.equal(server.clients(), 2)
  await sleep(400)
  assert.equal(a.of('snapshot').length, 2, 'the late page did not make the first one see a repeat')
})

test('server: with no page connected nothing runs; the first page starts the ticks and the last one stops them', async (t) => {
  const { server, data } = await start(t)
  await sleep(250)
  assert.equal(data.builds, 0, 'no page, no builds')
  const stream = await openEvents(server)
  await waitFor(() => stream.of('snapshot').length === 1)
  await waitFor(() => data.builds >= 2)
  stream.close()
  await waitFor(() => server.clients() === 0)
  const settled = data.builds
  await sleep(700)
  assert.equal(data.builds, settled, 'no builds once the last page left')
})

test('server: a build that throws is logged once, and the page still gets its activity', async (t) => {
  const { server, store, data } = await start(t, {
    build: () => {
      data.builds += 1
      throw new Error('store unreadable')
    },
  })
  const stream = await openEvents(server)
  t.after(() => stream.close())
  await waitFor(() => stream.of('activity').length === 1)
  await waitFor(() => data.builds >= 3)
  assert.equal(stream.of('snapshot').length, 0)
  const log = fs.readFileSync(store.path('logs', 'errors.log'), 'utf8')
  assert.equal(log.match(/dashboard: build: Error: store unreadable/g)?.length, 1, 'the same failure is logged once, not every tick')
  const api = await request(server, '/api/snapshot', { headers: { cookie: COOKIE } })
  assert.equal(api.status, 503)
})

test('server: a change under sessions/, projects/, events/ or to a root json file rebuilds at once, not on the next tick', async (t) => {
  const { server, store, data } = await start(t, { watch: true, intervalMs: 60_000 })
  for (const dir of ['sessions', 'projects/shop-1', 'events']) fs.mkdirSync(store.path(dir), { recursive: true })
  const stream = await openEvents(server)
  t.after(() => stream.close())
  await waitFor(() => stream.of('activity').length === 1)
  const changes = ['sessions/claude__s1.json', 'sessions/claude__s1/inbox/1-ab.json', 'projects/shop-1/ideas.json', 'config.json']
  for (const [i, rel] of changes.entries()) {
    data.n = 10 + i
    fs.mkdirSync(path.dirname(store.path(rel)), { recursive: true })
    fs.writeFileSync(store.path(rel), '{}')
    await waitFor(() => stream.of('snapshot').length === 2 + i)
    assert.equal(stream.of('snapshot').at(-1).n, 10 + i, rel)
  }
  const line = { t: NOW + 5, agent: 'grok', key: 'grok__g1', ev: 'tool.post' }
  data.incoming.push(line)
  fs.appendFileSync(store.path('events', '2026-10-12.jsonl'), '{}\n')
  await waitFor(() => stream.of('activity').length === 2)
  assert.deepEqual(stream.of('activity')[1], [line])
  await sleep(500)
  const builds = data.builds
  fs.writeFileSync(store.path('notes.txt'), 'not a settings file')
  await sleep(600)
  assert.equal(data.builds, builds, 'a root file that is not json is not watched')
})

test('server: /api/snapshot is the current snapshot, built on demand when no page is connected', async (t) => {
  const { server, data } = await start(t)
  const r = await request(server, '/api/snapshot', { headers: { cookie: COOKIE } })
  assert.equal(r.status, 200)
  const snapshot = JSON.parse(r.text)
  assert.equal(snapshot.n, 1)
  assert.deepEqual(snapshot.server, { pid: process.pid, startedAt: NOW, port: server.port })
  assert.equal(data.builds, 1)
  await request(server, '/api/snapshot', { headers: { cookie: COOKIE } })
  assert.equal(data.builds, 1, 'a fresh snapshot is reused, not rebuilt per request')
})

test('server: /api/resume gives the paste-ready command for a session in the snapshot; Devin also gets its note', async (t) => {
  const { server, store, data } = await start(t)
  const claudeKey = ['claude', 'abc-123'].join('__')
  data.sessions = [
    { key: claudeKey, agent: 'claude', id: 'abc-123', cwd: 'd:/work/shop', home: null },
    { key: 'devin__sample-session', agent: 'devin', id: 'sample-session', cwd: 'd:/work/shop', home: null },
    { key: 'cascade__t1', agent: 'cascade', id: 't1', cwd: 'd:/work/shop', home: null },
  ]
  // The snapshot only says a key is on the page; the command is built from the session's own record.
  for (const { key, agent, id, cwd, home } of data.sessions) store.writeJson(`sessions/${key}.json`, { v: 1, agent, id, key, cwd, home })
  const resume = async (query) => {
    const r = await request(server, `/api/resume?${query}`, { headers: { cookie: COOKIE } })
    return { status: r.status, body: JSON.parse(r.text) }
  }
  const ps = await resume(`key=${claudeKey}`)
  assert.equal(ps.status, 200)
  assert.equal(ps.body.command, resumeCommand({ agent: 'claude', id: 'abc-123', cwd: 'd:/work/shop', home: null }, 'powershell'))
  assert.equal(ps.body.note, null)
  assert.equal((await resume(`key=${claudeKey}&shell=bash`)).body.command, 'cd d:/work/shop && claude --resume abc-123')
  const devin = await resume('key=devin__sample-session&shell=cmd')
  assert.equal(devin.body.command, 'cd /d "d:\\work\\shop" && devin --resume sample-session')
  assert.match(devin.body.note, /devin\.exe/)
  assert.ok(!devin.body.command.includes('\n'), 'the note never rides inside the command a user pastes')
  assert.equal((await resume('key=claude__nope')).status, 404)
  assert.equal((await resume('shell=bash')).status, 404)
  assert.equal((await resume(`key=${claudeKey}&shell=zsh`)).status, 400)
  assert.equal((await resume('key=cascade__t1')).status, 409)
})

test('server: /api/brief returns the first prompt, context and a suggestion for a session on the page', async (t) => {
  const { server, store, data } = await start(t)
  const home = tempDir('am-grok-')
  const cwd = 'D:\\work\\shop'
  const id = '33333333-3333-4333-8333-333333333333'
  const dir = path.join(home, 'sessions', encodeURIComponent(cwd), id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'signals.json'), JSON.stringify({ contextTokensUsed: 158400, contextWindowTokens: 256000, compactionCount: 2 }))
  fs.writeFileSync(
    path.join(dir, 'chat_history.jsonl'),
    [
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_info>OS</user_info>' }] }),
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_query>\nfix the camera\n</user_query>' }] }),
    ].join('\n'),
  )
  const key = `grok__${id}`
  data.sessions = [{ key }]
  store.writeJson(`sessions/${key}.json`, { v: 1, agent: 'grok', id, key, cwd, home, done: 'posted the logo', next: 'open the PR', lastPrompt: 'commit this' })
  const r = await request(server, `/api/brief?key=${encodeURIComponent(key)}`, { headers: { cookie: COOKIE } })
  assert.equal(r.status, 200, r.text)
  const body = JSON.parse(r.text)
  assert.equal(body.ok, true)
  assert.equal(body.firstPrompt, 'fix the camera')
  assert.equal(body.truncated, false)
  assert.deepEqual(body.context, { used: 158400, window: 256000, percent: 62, compactions: 2 })
  assert.match(body.contextText, /158,400 \/ 256,000 \(62%\)/)
  assert.match(body.contextText, /Compacted 2 times/)
  assert.match(body.suggestion, /open the PR/)
  assert.equal((await request(server, '/api/brief?key=grok__missing', { headers: { cookie: COOKIE } })).status, 404)
  assert.equal((await request(server, '/api/brief', { headers: { cookie: COOKIE } })).status, 404)
})

test('server: close() ends every open stream, stops the server and is safe to call twice', async () => {
  const { store, env } = tempStore()
  const { data, options } = fakes()
  const server = await startDashboard({ store, env, port: 0, token: TOKEN, ...options })
  const a = await openEvents(server)
  const b = await openEvents(server)
  await waitFor(() => server.clients() === 2)
  await Promise.all([server.close(), server.close()])
  await Promise.all([a.ended, b.ended])
  assert.equal(server.clients(), 0)
  await server.close()
  await assert.rejects(request(server, '/healthz'), /ECONNREFUSED/)
  const builds = data.builds
  await sleep(200)
  assert.equal(data.builds, builds, 'no tick survives close()')
})

test('server: /healthz answers without the cookie and says only who it is', async (t) => {
  const { server } = await start(t)
  const r = await request(server, '/healthz')
  assert.equal(r.status, 200)
  assert.match(r.headers['content-type'], /^application\/json/)
  assert.deepEqual(JSON.parse(r.text), { app: 'agent-mods-dashboard', v: 1, pid: process.pid, port: server.port, clients: 0 })
  assert.equal((await request(server, '/healthz', { method: 'POST' })).status, 405)
})

test('server: a token is required, and a taken port fails with EADDRINUSE for the caller to handle', async (t) => {
  const { store, env } = tempStore()
  const { options } = fakes()
  await assert.rejects(startDashboard({ store, env, port: 0, token: '', ...options }), /token/)
  const { server } = await start(t)
  await assert.rejects(startDashboard({ store, env, port: server.port, token: TOKEN, ...options }), { code: 'EADDRINUSE' })
})

// ---------------------------------------------------------------- instance: token, file, probe

const DEAD_PID = 2147483644

function listenOn(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function shut(server) {
  server.closeAllConnections()
  return new Promise((resolve) => server.close(() => resolve()))
}

test('instance: the token is made once (24 random bytes as base64url, file mode 0600) and then reused', () => {
  const { store } = tempStore()
  const file = store.path('dashboard', 'token')
  const first = ensureToken(store)
  assert.match(first, /^[A-Za-z0-9_-]{32}$/)
  assert.equal(ensureToken(store), first, 'the second read gives the same token')
  assert.equal(fs.readFileSync(file, 'utf8').trim(), first)
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.notEqual(ensureToken(tempStore().store), first, 'every store has its own')
  fs.writeFileSync(file, 'not a token')
  const fresh = ensureToken(store)
  assert.match(fresh, /^[A-Za-z0-9_-]{32}$/, 'a damaged token file is replaced')
  assert.equal(ensureToken(store), fresh)
})

test('instance: a token file that cannot be read is an error, never a silent new token', async () => {
  const { store, env } = tempStore()
  fs.mkdirSync(store.path('dashboard', 'token'), { recursive: true })
  assert.throws(() => ensureToken(store), { code: 'EISDIR' })
  assert.equal(readToken(store), null)
  assert.ok(fs.statSync(store.path('dashboard', 'token')).isDirectory(), 'left as it was')
  const io = sink()
  const code = await runDashboard(makeCliContext({ argv: ['--no-open'], env, stdout: io.stdout, stderr: io.stderr }), { spawner: noSpawn })
  assert.equal(code, 1)
  assert.match(io.err, /The dashboard could not start/)
})

test('instance: the instance file round-trips, and only its own pid removes it', () => {
  const { store } = tempStore()
  assert.equal(readInstance(store), null)
  writeInstance(store, { pid: 1234, port: 4747, startedAt: NOW })
  assert.deepEqual(readInstance(store), { v: 1, pid: 1234, port: 4747, startedAt: NOW })
  assert.deepEqual(store.readJson('dashboard/instance.json'), { v: 1, pid: 1234, port: 4747, startedAt: NOW })
  removeInstance(store, 999)
  assert.ok(readInstance(store), 'another pid leaves it alone')
  removeInstance(store, 1234)
  assert.equal(readInstance(store), null)
  store.writeJson('dashboard/instance.json', { v: 1, pid: 'x', port: 4747 })
  assert.equal(readInstance(store), null, 'a malformed file reads as none')
})

test('instance: probe gives the health answer of our server, null for a closed port or a stranger, and busy for silence', async (t) => {
  const { server } = await start(t)
  assert.deepEqual(await probe(server.port), { app: HEALTH_APP, v: 1, pid: process.pid, port: server.port, clients: 0 })
  const closed = http.createServer()
  const closedPort = await listenOn(closed)
  await shut(closed)
  assert.equal(await probe(closedPort), null)
  const stranger = http.createServer((req, res) => res.end(JSON.stringify({ app: 'something-else', v: 1, pid: process.pid })))
  const strangerPort = await listenOn(stranger)
  t.after(() => shut(stranger))
  assert.equal(await probe(strangerPort), null)
  const silent = http.createServer(() => {})
  const silentPort = await listenOn(silent)
  t.after(() => shut(silent))
  const started = Date.now()
  assert.equal(await probe(silentPort, { timeoutMs: 200 }), 'busy', 'it took the connection: alive, only not answering')
  assert.ok(Date.now() - started < 1500, 'gives up at its timeout')
})

test('instance: a missing file, a dead pid, or a live pid that /healthz does not confirm is not running', async (t) => {
  const { store } = tempStore()
  assert.equal(await findRunning(store), null, 'no instance file')
  writeInstance(store, { pid: DEAD_PID, port: 9, startedAt: NOW })
  assert.equal(await findRunning(store), null, 'a dead pid')
  const { server } = await start(t)
  writeInstance(store, { pid: process.ppid, port: server.port, startedAt: NOW })
  assert.equal(await findRunning(store), null, 'a live pid (a reused one) that is not the server on that port')
  writeInstance(store, { pid: process.pid, port: server.port, startedAt: NOW })
  assert.deepEqual(await findRunning(store), { v: 1, pid: process.pid, port: server.port, startedAt: NOW, busy: false, clients: 0 })
})

test('instance: stop kills only a pid that /healthz confirms, waits for it to die, then removes the file', async () => {
  const { store } = tempStore()
  const killed = []
  let alive = true
  const ours = async (port) => ({ app: HEALTH_APP, v: 1, pid: 4242, port })
  const deps = {
    alive: () => alive,
    kill: (pid) => {
      killed.push(pid)
      alive = false
    },
    probeFn: ours,
  }
  assert.deepEqual(await stopInstance(store, deps), { status: 'not-running', pid: null })
  writeInstance(store, { pid: 4242, port: 5555, startedAt: NOW })
  assert.deepEqual(await stopInstance(store, deps), { status: 'stopped', pid: 4242 })
  assert.deepEqual(killed, [4242])
  assert.equal(readInstance(store), null)

  for (const probeFn of [async () => null, async (port) => ({ app: HEALTH_APP, v: 1, pid: 9999, port })]) {
    alive = true
    writeInstance(store, { pid: 4242, port: 5555, startedAt: NOW })
    assert.deepEqual(await stopInstance(store, { ...deps, probeFn }), { status: 'not-running', pid: 4242 })
    assert.deepEqual(killed, [4242], 'a pid the server does not confirm is never killed')
    assert.equal(readInstance(store), null, 'its stale file goes')
  }

  alive = false
  writeInstance(store, { pid: 4242, port: 5555, startedAt: NOW })
  assert.deepEqual(await stopInstance(store, deps), { status: 'not-running', pid: 4242 })
  assert.equal(readInstance(store), null, 'a dead pid leaves a stale file, which goes')

  writeInstance(store, { pid: 4242, port: 5555, startedAt: NOW })
  const stuck = await stopInstance(store, { alive: () => true, kill: () => {}, probeFn: ours, waitMs: 200 })
  assert.deepEqual(stuck, { status: 'stuck', pid: 4242 })
  assert.ok(readInstance(store), 'a server that would not die is still on record')
})

test('instance: startDetached runs node on the CLI detached and hidden, then waits until the server answers', async (t) => {
  const { store, env } = tempStore()
  const calls = []
  let server = null
  t.after(() => server?.close())
  // What the real child does, in this process: listen, then write the instance file.
  const spawner = (command, args, options) => {
    const child = new EventEmitter()
    child.pid = process.pid
    child.unref = () => {
      child.unrefed = true
    }
    calls.push({ command, args, options, child })
    setTimeout(async () => {
      server = await startDashboard({ store, env, port: 0, token: TOKEN, ...fakes().options })
      writeInstance(store, { pid: process.pid, port: server.port, startedAt: NOW })
    }, 100)
    return child
  }
  const running = await startDetached({ store, port: 4747, env, spawner })
  assert.equal(running?.pid, process.pid)
  assert.equal(running.port, server.port)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, process.execPath)
  assert.deepEqual(calls[0].args, [CLI_SCRIPT, 'dashboard', '--foreground', '--no-open', '--port', '4747'])
  assert.equal(calls[0].options.detached, true)
  assert.equal(calls[0].options.stdio, 'ignore')
  assert.equal(calls[0].options.windowsHide, true)
  assert.equal(calls[0].options.env, env)
  assert.ok(calls[0].child.unrefed, 'the CLI does not wait on the server')
})

test('instance: startDetached gives up as soon as the child exits or fails to start, not after the full wait', async () => {
  const { store, env } = tempStore()
  for (const event of [['exit', 1], ['error', new Error('spawn ENOENT')]]) {
    const spawner = () => {
      const child = new EventEmitter()
      child.unref = () => {}
      setTimeout(() => child.emit(...event), 50)
      return child
    }
    const started = Date.now()
    assert.equal(await startDetached({ store, port: 4747, env, spawner, waitMs: 6000 }), null)
    assert.ok(Date.now() - started < 2000, `${event[0]}: gave up early`)
  }
  const throwing = () => {
    throw new Error('spawn EPERM')
  }
  assert.equal(await startDetached({ store, port: 4747, env, spawner: throwing }), null)
})

// ---------------------------------------------------------------- the dashboard command

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'exit']
const listenerCounts = () => SIGNALS.map((name) => process.listenerCount(name))

const noSpawn = () => {
  throw new Error('a test tried to start a server process')
}

function sink() {
  const io = { out: '', err: '' }
  io.stdout = { write: (s) => ((io.out += s), true) }
  io.stderr = { write: (s) => ((io.err += s), true) }
  return io
}

// The real CLI path: runCli with the command registered the way bin/agent-mods.mjs registers it.
async function cli(env, ...argv) {
  const io = sink()
  const code = await runCli({ argv: ['dashboard', ...argv], env, stdout: io.stdout, stderr: io.stderr, mods: [], extraCommands: DASHBOARD_COMMANDS })
  return { code, out: io.out, err: io.err }
}

// The command with its test seams: a spawner that refuses by default, and the fakes for the server.
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

test('cli: --foreground is a boolean flag, so the word after it stays a subcommand', () => {
  assert.deepEqual(parseArgs(['--foreground', 'stop']), { flags: { foreground: true }, positionals: ['stop'] })
})

test('command: agent-mods dashboard status (and stop) with no dashboard running say it is not running', async () => {
  const { env } = tempStore()
  const status = await cli(env, 'status')
  assert.equal(status.code, 1)
  assert.match(status.out, /The dashboard is not running/)
  assert.deepEqual(JSON.parse((await cli(env, 'status', '--json')).out), { running: false })
  const stop = await cli(env, 'stop')
  assert.equal(stop.code, 0)
  assert.match(stop.out, /The dashboard is not running/)
})

test('command: an unknown subcommand or a bad --port is a usage error (exit 2) and starts nothing', async () => {
  const { env } = tempStore()
  const bad = [['nope'], ['status', 'now'], ['--port'], ['--port', 'abc'], ['--port', '80'], ['--port', '70000'], ['--port', '47.5'], ['--port', '-1'], ['--foreground', '--port']]
  for (const argv of bad) {
    const r = await dash(env, argv)
    assert.equal(r.code, 2, argv.join(' '))
    assert.match(r.err, /Usage: agent-mods dashboard/, argv.join(' '))
  }
  const help = await cli(env, '--help')
  assert.equal(help.code, 0)
  assert.match(help.out, /agent-mods dashboard stop \| status/)
})

test('command: start runs the server in the background, prints the link with its token, then reuses it', async (t) => {
  const { env, store } = tempStore()
  const quiet = { ...env, AGENT_MODS_NO_BROWSER: '1' }
  const spawned = []
  let server = null
  t.after(() => server?.close())
  // In place of the detached `dashboard --foreground`: a server in this process that records itself.
  const spawner = (command, args) => {
    spawned.push(args)
    const child = new EventEmitter()
    child.unref = () => {}
    setTimeout(async () => {
      server = await startDashboard({ store, env, port: 0, token: ensureToken(store), ...fakes().options })
      writeInstance(store, { pid: process.pid, port: server.port, startedAt: NOW })
    }, 50)
    return child
  }
  const first = await dash(quiet, ['--port', '5151', '--json'], { spawner })
  assert.equal(first.code, 0, first.err)
  const url = `http://127.0.0.1:${server.port}/?t=${readToken(store)}`
  assert.deepEqual(JSON.parse(first.out), { url, pid: process.pid, port: server.port, started: true, opened: false, alreadyOpen: false })
  assert.deepEqual(spawned, [[CLI_SCRIPT, 'dashboard', '--foreground', '--no-open', '--port', '5151']])

  const again = await dash(quiet, ['--no-open'], { spawner })
  assert.equal(again.code, 0)
  assert.equal(spawned.length, 1, 'a running dashboard is reused, never started twice')
  assert.match(again.out, /already running/)
  assert.ok(again.out.split('\n').includes(url), 'the link is printed on a line of its own')
  const page = await request(server, new URL(url).pathname + new URL(url).search)
  assert.equal(page.status, 303, 'the printed link signs the browser in')
})

test('command: start exits 1 and points at --foreground when no server comes up; the port is 4747 unless told', async () => {
  const { env } = tempStore()
  const spawned = []
  const spawner = (command, args) => {
    spawned.push(args)
    const child = new EventEmitter()
    child.unref = () => {}
    setTimeout(() => child.emit('exit', 1), 20)
    return child
  }
  const r = await dash({ ...env, AGENT_MODS_NO_BROWSER: '1' }, [], { spawner })
  assert.equal(r.code, 1)
  assert.match(r.err, /agent-mods dashboard --foreground/)
  assert.deepEqual(spawned[0].slice(-2), ['--port', '4747'])
})

test('command: --foreground serves from this process, records itself, and Ctrl+C stops it and clears the record', async () => {
  const { env, store } = tempStore()
  const quiet = { ...env, AGENT_MODS_NO_BROWSER: '1' }
  const { options } = fakes()
  const before = listenerCounts()
  const sigint = process.listeners('SIGINT')
  const run = dashRun(quiet, ['--foreground', '--port', '0', '--no-open'], { server: options })
  try {
    const instance = await waitFor(() => readInstance(store))
    assert.equal(instance.pid, process.pid)
    const url = `http://127.0.0.1:${instance.port}/?t=${readToken(store)}`
    await waitFor(() => run.io.out.includes(url))
    assert.deepEqual(await findRunning(store), { ...instance, busy: false, clients: 0 })
    const status = await cli(quiet, 'status')
    assert.equal(status.code, 0)
    assert.match(status.out, /The dashboard is running \(pid \d+, port \d+/)
    assert.ok(status.out.includes(url))
    assert.deepEqual(JSON.parse((await cli(quiet, 'status', '--json')).out), { running: true, pid: process.pid, port: instance.port, startedAt: instance.startedAt, url })
    const second = await dash(quiet, ['--foreground', '--port', '0', '--no-open'], { server: options })
    assert.equal(second.code, 1, 'a second foreground server is refused')
    assert.match(second.err, /already running/)
    assert.deepEqual(listenerCounts(), before.map((n) => n + 1), 'one listener each for ctrl+c, ctrl+break, SIGTERM and exit')
  } finally {
    pressCtrlC(sigint)
  }
  assert.equal(await run.done, 0)
  assert.equal(readInstance(store), null, 'the record leaves with the server')
  assert.equal(await findRunning(store), null)
  assert.deepEqual(listenerCounts(), before, 'and so do the listeners')
})

test('command: --foreground moves to a free port when another program holds the one asked for', async (t) => {
  const { env, store } = tempStore()
  const blocker = http.createServer()
  const taken = await listenOn(blocker)
  t.after(() => shut(blocker))
  const sigint = process.listeners('SIGINT')
  const run = dashRun({ ...env, AGENT_MODS_NO_BROWSER: '1' }, ['--foreground', '--port', String(taken), '--no-open'], { server: fakes().options })
  try {
    const instance = await waitFor(() => readInstance(store), 6000)
    assert.notEqual(instance.port, taken)
    assert.ok(await findRunning(store))
  } finally {
    pressCtrlC(sigint)
  }
  assert.equal(await run.done, 0)
})
