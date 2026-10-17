// The dashboard's HTTP end: one node:http server on 127.0.0.1 that serves the page from a fixed list
// of files, pushes snapshots and activity lines to every open page over Server-Sent Events, and
// answers the page's resume and action calls. With no page connected it does no work at all: the
// tick, the ping and the file watchers start with the first page and stop with the last.
//
// Safety (docs/plans/2026-10-12-dashboard.md, HTTP): the Host header must be exactly 127.0.0.1:<port>
// (DNS rebinding); every route but /healthz needs the token cookie; a POST also needs this exact
// Origin, because SameSite ignores ports and a dev server on another localhost port is "same site";
// the HTML gets a CSP with no inline script or style; no CORS header is ever sent.
//
// Store: read only, through build (snapshot.mjs), activity (activity.mjs) and, for /api/resume and
// /api/brief, the one session record asked for (or that session's entry in its agent's own registry).
// /api/brief also reads that agent's own transcript. act (actions.mjs) is the one writer. While a page is open it watches sessions/, projects/, events/ and
// the root's json files (config.json, plain.json, clawd.json). dashboard/token and
// dashboard/instance.json belong to instance.mjs.
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CODE_ROOT } from '../core/paths.mjs'
import { readRecord } from '../core/session-records.mjs'
import { logError, sessionKey } from '../core/store.mjs'
import { DONE_WAV } from '../mods/plain-notify.mjs'
import { nativeRows } from '../mods/sessions-data.mjs'
import { canResume, label, resumeCommand } from '../mods/sessions-text.mjs'
import { contextLabel, readBrief } from './brief.mjs'
import { HEALTH_APP } from './instance.mjs'

export const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url))
export const MAX_ACTION_BYTES = 16 * 1024
const COOKIE_NAME = 'amdash'
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60
const PING_MS = 15_000
const WATCH_DELAY_MS = 150
const MIN_BUILD_GAP_MS = 300
// The floor between two snapshot pushes. Every hook write moves a session's `since`, so a busy store
// changes the signature several times a second, and each push is the whole snapshot to every page.
const MIN_PUSH_GAP_MS = 1000
// A page whose tab stopped reading is dropped past this; its EventSource reconnects and starts fresh.
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024
// close() lets a reply still being written finish, but never waits longer than this.
const CLOSE_GRACE_MS = 1000
const SHELLS = ['powershell', 'bash', 'cmd']
// The note sessions.mjs adds to a Devin resume command. Here it travels beside the command, never
// inside it, so what the user pastes into a terminal is one command and nothing else.
const DEVIN_NOTE = 'The devin CLI ships inside Devin Desktop at <install>/resources/app/extensions/windsurf/devin/bin/devin.exe and is not on PATH by default.'

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

const SAFE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
}

const TYPE = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml',
  wav: 'audio/wav',
  json: 'application/json; charset=utf-8',
  text: 'text/plain; charset=utf-8',
  events: 'text/event-stream; charset=utf-8',
}

const LOCKED_PAGE =
  '<!doctype html><meta charset="utf-8"><title>agent-mods dashboard</title><p>Run <code>agent-mods dashboard</code> in a terminal to open the dashboard.</p>\n'

// URL path -> [file, type]. Only exact paths match and nothing from the URL is ever joined to a
// folder, so no spelling of ".." reaches another file.
function fileTable(publicDir) {
  const mods = path.join(CODE_ROOT, 'lib', 'mods')
  return new Map([
    ['/', [path.join(publicDir, 'index.html'), TYPE.html]],
    ['/app.css', [path.join(publicDir, 'app.css'), TYPE.css]],
    ['/app.js', [path.join(publicDir, 'app.js'), TYPE.js]],
    ['/pets.js', [path.join(publicDir, 'pets.js'), TYPE.js]],
    ['/favicon.svg', [path.join(publicDir, 'favicon.svg'), TYPE.svg]],
    ['/clawd-sprite.mjs', [path.join(mods, 'clawd-sprite.mjs'), TYPE.js]],
    ['/clawd-world.mjs', [path.join(mods, 'clawd-world.mjs'), TYPE.js]],
    ['/done.wav', [DONE_WAV, TYPE.wav]],
  ])
}

// The watched folders: [store-relative path, recursive]. "." is the store root, for its json files.
const WATCHED = [
  ['sessions', true],
  ['projects', true],
  ['events', false],
  ['.', false],
]

function sameToken(given, token) {
  const a = Buffer.from(String(given ?? ''))
  const b = Buffer.from(token)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function hasTokenCookie(req, token) {
  return String(req.headers.cookie ?? '')
    .split(';')
    .some((part) => {
      const at = part.indexOf('=')
      return at > 0 && part.slice(0, at).trim() === COOKIE_NAME && sameToken(part.slice(at + 1).trim(), token)
    })
}

function splitTarget(url = '') {
  const at = url.indexOf('?')
  return at < 0 ? [url, ''] : [url.slice(0, at), url.slice(at + 1)]
}

function send(res, status, type, body = '', extra = {}) {
  if (res.headersSent) {
    if (!res.writableEnded) res.end()
    return
  }
  const headers = { ...SAFE_HEADERS, ...extra, 'content-length': Buffer.byteLength(body) }
  if (type) headers['content-type'] = type
  if (type === TYPE.html) headers['content-security-policy'] = CSP
  res.writeHead(status, headers)
  res.end(body)
}

function sendJson(res, status, value) {
  send(res, status, TYPE.json, JSON.stringify(value))
}

function notAllowed(res, allow) {
  send(res, 405, TYPE.text, 'Method not allowed\n', { allow })
}

const eventFrame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

// Resolves once listening: { url, port, close(), clients() }. close() resolves when the server has
// stopped; clients() is the number of open pages. A taken port rejects with the listen error
// (code EADDRINUSE), for the caller to pick another.
export async function startDashboard({
  store,
  env = process.env,
  port = 0,
  token,
  clock = Date.now,
  intervalMs = 2000,
  build,
  signature,
  act,
  activity,
  watch = true,
  publicDir = PUBLIC_DIR,
} = {}) {
  if (typeof token !== 'string' || !token) throw new TypeError('startDashboard needs the token')
  // The data modules load only when nothing was injected, so the server's tests run without them.
  if (!build || !signature) {
    const snapshots = await import('./snapshot.mjs')
    build ??= snapshots.buildSnapshot
    signature ??= snapshots.signature
  }
  act ??= (await import('./actions.mjs')).runAction
  activity ??= (await import('./activity.mjs')).createActivity

  const files = fileTable(publicDir)
  // Each open page's response, with the signature of the last snapshot it was sent.
  const streams = new Map()
  const watchers = new Map()
  const logged = new Map()
  let host = ''
  let origin = ''
  let info = null
  let latest = null
  let builtAt = -Infinity
  let pushedAt = -Infinity
  let feed = null
  let tickTimer = null
  let pingTimer = null
  let pushTimer = null
  let soon = null
  let closed = false
  let closing = null

  // A failure that repeats on every tick is logged once, until it clears or its message changes. The
  // message is the key: the same failure has a different stack from the tick and from a page joining.
  function report(area, err) {
    const message = String(err?.message ?? err)
    if (logged.get(area) === message) return
    logged.set(area, message)
    logError(store, `dashboard: ${area}: ${err?.stack ?? err}`)
  }

  function push(res, text) {
    if (res.writableEnded || res.destroyed) return
    if (res.writableLength > MAX_BUFFERED_BYTES) {
      res.destroy()
      return
    }
    try {
      res.write(text)
    } catch {}
  }

  function broadcast(event, data) {
    if (!streams.size) return
    const text = eventFrame(event, data)
    for (const res of streams.keys()) push(res, text)
  }

  // The newest snapshot goes to every page that does not have it yet, but never within
  // MIN_PUSH_GAP_MS of the last push: a change inside that gap goes out when it ends, folded into
  // whatever was built by then, so the last change always arrives. A page that joins gets its first
  // snapshot at once (openStream), outside this floor.
  function pushSnapshot() {
    if (closed || !latest) return
    const behind = [...streams].filter(([, sig]) => sig !== latest.sig).map(([res]) => res)
    if (!behind.length) return
    const wait = MIN_PUSH_GAP_MS - (performance.now() - pushedAt)
    if (wait > 0) {
      if (!pushTimer) {
        pushTimer = setTimeout(() => {
          pushTimer = null
          try {
            pushSnapshot()
          } catch (err) {
            report('push', err)
          }
        }, wait)
        pushTimer.unref()
      }
      return
    }
    pushedAt = performance.now()
    const text = eventFrame('snapshot', latest.snapshot)
    for (const res of behind) {
      push(res, text)
      if (streams.has(res)) streams.set(res, latest.sig)
    }
  }

  // One build serves every page; a page is sent it only when its signature moved. The gap to the next
  // build counts from the end of this one, so even a build slower than the tick is followed by idle
  // time for /healthz, the actions and the activity lines.
  function rebuild() {
    try {
      const snapshot = build(store, { now: clock(), env, server: info })
      latest = { snapshot, sig: String(signature(snapshot)) }
      logged.delete('build')
      pushSnapshot()
    } catch (err) {
      report('build', err)
    } finally {
      builtAt = performance.now()
    }
  }

  // The snapshot as of now: rebuilt only when the last build is older than one tick.
  function current() {
    if (!latest || performance.now() - builtAt >= Math.max(intervalMs, MIN_BUILD_GAP_MS)) rebuild()
    return latest?.snapshot ?? null
  }

  function tick() {
    if (closed || !streams.size) return
    try {
      try {
        const lines = feed ? feed.read(clock()) : []
        if (lines?.length) broadcast('activity', lines)
        logged.delete('activity')
      } catch (err) {
        report('activity', err)
      }
      if (watch) watchAll()
      if (performance.now() - builtAt >= MIN_BUILD_GAP_MS) rebuild()
    } catch (err) {
      report('tick', err)
    }
  }

  // A watcher saw a change, or an action made one: rebuild 150 ms later but never within 300 ms of
  // the last build, folding every change in between into that one rebuild.
  function later() {
    if (closed || !streams.size || soon) return
    soon = setTimeout(flush, Math.max(WATCH_DELAY_MS, MIN_BUILD_GAP_MS - (performance.now() - builtAt)))
    soon.unref()
  }

  function flush() {
    soon = null
    const gap = performance.now() - builtAt
    // A tick built in the meantime, maybe before the change landed: wait out the gap, then build.
    if (gap < MIN_BUILD_GAP_MS) {
      soon = setTimeout(flush, MIN_BUILD_GAP_MS - gap)
      soon.unref()
      return
    }
    tick()
  }

  // Watchers are hints: the tick rebuilds anyway, so a folder that does not exist yet (or a watcher
  // that failed) costs freshness, never correctness, and is tried again on the next tick.
  function watchAll() {
    for (const [rel, recursive] of WATCHED) {
      if (watchers.has(rel)) continue
      try {
        const watcher = fs.watch(store.path(rel), { recursive, persistent: false }, (_type, name) => {
          try {
            if (rel === '.' && name && !String(name).endsWith('.json')) return
            later()
          } catch (err) {
            report('watch', err)
          }
        })
        watcher.on('error', () => {
          try {
            watcher.close()
          } catch {}
          if (watchers.get(rel) === watcher) watchers.delete(rel)
        })
        watchers.set(rel, watcher)
      } catch {}
    }
  }

  function startWork() {
    try {
      feed = activity(store, { now: clock() })
      feed.seed()
      logged.delete('activity')
    } catch (err) {
      feed = null
      report('activity', err)
    }
    tickTimer = setInterval(tick, intervalMs)
    tickTimer.unref()
    pingTimer = setInterval(() => {
      for (const res of streams.keys()) push(res, ': ping\n\n')
    }, PING_MS)
    pingTimer.unref()
    if (watch) watchAll()
  }

  function stopWork() {
    clearInterval(tickTimer)
    clearInterval(pingTimer)
    clearTimeout(soon)
    clearTimeout(pushTimer)
    tickTimer = null
    pingTimer = null
    soon = null
    pushTimer = null
    for (const watcher of watchers.values()) {
      try {
        watcher.close()
      } catch {}
    }
    watchers.clear()
    feed = null
  }

  function drop(res) {
    streams.delete(res)
    if (!streams.size) stopWork()
  }

  function openStream(req, res) {
    // Connection: close, so ending the stream (close()) also ends its socket.
    res.writeHead(200, { ...SAFE_HEADERS, 'content-type': TYPE.events, connection: 'close' })
    req.socket.setNoDelay(true)
    res.on('close', () => drop(res))
    if (!tickTimer) startWork()
    // Built before this page joins, so a changed snapshot is not sent to it twice.
    const snapshot = current()
    streams.set(res, latest?.sig ?? null)
    if (snapshot) push(res, eventFrame('snapshot', snapshot))
    let recent = []
    try {
      recent = feed ? feed.recent() : []
    } catch (err) {
      report('activity', err)
    }
    // Always a first frame, so the page's EventSource opens even when nothing could be read.
    push(res, eventFrame('activity', recent))
    if (res.destroyed) drop(res)
  }

  function snapshotAnswer(req, res) {
    const snapshot = current()
    if (!snapshot) return sendJson(res, 503, { ok: false, text: 'The dashboard could not read the store; see logs/errors.log.' })
    sendJson(res, 200, snapshot)
  }

  // The session behind a key on the page, read the way `agent-mods sessions resume` reads it
  // (resumeCandidates): its record, or for a session with no record, its entry in Claude's or Grok's
  // own registry. The snapshot's values are cleaned for display, and a command built from a cleaned
  // folder can send the user to one that does not exist; resumeCommand refuses what it cannot quote.
  function rawSession(key) {
    const session = readRecord(store, key) ?? nativeRows(env).find((row) => sessionKey(row.agent, row.id) === key)
    return session?.agent && session.id && sessionKey(session.agent, session.id) === key ? session : null
  }

  function resumeAnswer(req, res, params) {
    const shell = params.get('shell') || 'powershell'
    if (!SHELLS.includes(shell)) return sendJson(res, 400, { ok: false, text: `shell is one of ${SHELLS.join(', ')}.` })
    const snapshot = current()
    if (!snapshot) return sendJson(res, 503, { ok: false, text: 'The dashboard could not read the store; see logs/errors.log.' })
    const key = params.get('key')
    const rows = Array.isArray(snapshot.sessions) ? snapshot.sessions : []
    // The snapshot only says the key is on the page; everything in the command is the raw session's.
    const shown = key ? rows.some((row) => row?.key === key) : false
    const s = shown ? rawSession(key) : null
    if (!s) return sendJson(res, 404, { ok: false, text: 'No such session on the dashboard.' })
    if (!canResume(s.agent)) return sendJson(res, 409, { ok: false, text: `${label(s.agent)} sessions cannot be reopened from a terminal.` })
    const session = { agent: s.agent, id: String(s.id), cwd: typeof s.cwd === 'string' ? s.cwd : '', home: typeof s.home === 'string' ? s.home : null }
    const command = resumeCommand(session, shell)
    if (!command) return sendJson(res, 409, { ok: false, text: `No safe ${shell} command for this session; try another shell.` })
    sendJson(res, 200, { ok: true, command, note: s.agent === 'devin' ? DEVIN_NOTE : null })
  }

  // The first prompt, context used and a continue suggestion. Loaded when a row opens, not on the
  // snapshot: a full prompt does not belong in the push that every page gets every second.
  function briefAnswer(req, res, params) {
    const snapshot = current()
    if (!snapshot) return sendJson(res, 503, { ok: false, text: 'The dashboard could not read the store; see logs/errors.log.' })
    const key = params.get('key')
    const rows = Array.isArray(snapshot.sessions) ? snapshot.sessions : []
    const shown = key ? rows.some((row) => row?.key === key) : false
    const s = shown ? rawSession(key) : null
    if (!s) return sendJson(res, 404, { ok: false, text: 'No such session on the dashboard.' })
    const brief = readBrief({
      agent: s.agent,
      id: String(s.id),
      cwd: typeof s.cwd === 'string' ? s.cwd : '',
      home: typeof s.home === 'string' ? s.home : null,
      lastPrompt: typeof s.lastPrompt === 'string' ? s.lastPrompt : null,
      done: typeof s.done === 'string' ? s.done : null,
      doing: typeof s.doing === 'string' ? s.doing : null,
      next: typeof s.next === 'string' ? s.next : null,
      answer: typeof s.lastAnswer === 'string' ? s.lastAnswer : null,
    })
    sendJson(res, 200, { ok: true, firstPrompt: brief.firstPrompt, truncated: brief.truncated, context: brief.context, contextText: contextLabel(brief.context), suggestion: brief.suggestion })
  }

  function actionAnswer(req, res) {
    if (req.headers.origin !== origin) return sendJson(res, 403, { ok: false, text: 'Actions come only from the dashboard page itself.' })
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (type !== 'application/json') return sendJson(res, 415, { ok: false, text: 'Send the action as application/json.' })
    const tooBig = () => sendJson(res, 413, { ok: false, text: `An action is at most ${MAX_ACTION_BYTES / 1024} KB.` })
    // Answered without reading the body; node drains the rest, so the client still gets the 413.
    if (Number(req.headers['content-length']) > MAX_ACTION_BYTES) return tooBig()
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= MAX_ACTION_BYTES) chunks.push(chunk)
      else if (!res.headersSent) tooBig()
    })
    req.on('end', () => {
      if (size > MAX_ACTION_BYTES) return
      runAction(res, Buffer.concat(chunks).toString('utf8')).catch((err) => {
        report('request', err)
        send(res, 500, TYPE.text, 'Internal error\n')
      })
    })
  }

  async function runAction(res, text) {
    let body
    try {
      body = JSON.parse(text)
    } catch {
      return sendJson(res, 400, { ok: false, text: 'The body is not valid JSON.' })
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { ok: false, text: 'The body must be a JSON object.' })
    let result
    try {
      result = await act(store, body, { now: clock(), env })
    } catch (err) {
      report('action', err)
      return sendJson(res, 500, { ok: false, text: 'The action failed; see logs/errors.log.' })
    }
    const status = Number.isInteger(result?.status) && result.status >= 200 && result.status <= 599 ? result.status : 500
    sendJson(res, status, result ?? { ok: false, text: 'The action returned nothing.' })
    later()
  }

  const getRoutes = { '/events': openStream, '/api/snapshot': snapshotAnswer, '/api/resume': resumeAnswer, '/api/brief': briefAnswer }

  function route(req, res) {
    if (req.headers.host !== host) return send(res, 403, TYPE.text, 'Forbidden\n')
    const [pathname, query] = splitTarget(req.url)
    if (pathname === '/healthz') {
      if (req.method !== 'GET') return notAllowed(res, 'GET')
      // clients, the open event streams, is a count only: `agent-mods dashboard` reads it to point at
      // a page that is already open instead of opening one more tab.
      return sendJson(res, 200, { app: HEALTH_APP, v: 1, pid: process.pid, port: info.port, clients: streams.size })
    }
    const params = new URLSearchParams(query)
    if (pathname === '/' && req.method === 'GET' && params.has('t') && sameToken(params.get('t'), token)) {
      const cookie = `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`
      return send(res, 303, null, '', { location: '/', 'set-cookie': cookie })
    }
    if (!hasTokenCookie(req, token)) return send(res, 401, TYPE.html, LOCKED_PAGE)
    if (pathname === '/api/action') return req.method === 'POST' ? actionAnswer(req, res) : notAllowed(res, 'POST')
    const file = files.get(pathname)
    const handler = getRoutes[pathname] ?? (file ? () => serveFile(res, file) : null)
    if (!handler) return send(res, 404, TYPE.text, 'Not found\n')
    if (req.method !== 'GET') return notAllowed(res, 'GET')
    return handler(req, res, params)
  }

  function serveFile(res, [file, type]) {
    fs.readFile(file, (err, body) => {
      try {
        if (!err) return send(res, 200, type, body)
        if (err.code !== 'ENOENT') report('file', err)
        send(res, err.code === 'ENOENT' ? 404 : 500, TYPE.text, err.code === 'ENOENT' ? 'Not found\n' : 'Could not read the file\n')
      } catch (error) {
        report('request', error)
      }
    })
  }

  // requireHostHeader off: a request with no Host gets this server's 403, not node's bare 400.
  const server = http.createServer({ requireHostHeader: false }, (req, res) => {
    // A client that drops mid-request emits 'error'; unhandled, it would take the process down.
    req.on('error', () => {})
    res.on('error', () => {})
    try {
      route(req, res)
    } catch (err) {
      report('request', err)
      send(res, 500, TYPE.text, 'Internal error\n')
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  server.on('error', (err) => report('server', err))
  const bound = server.address().port
  host = `127.0.0.1:${bound}`
  origin = `http://${host}`
  info = { pid: process.pid, startedAt: clock(), port: bound }

  // Ends every page's stream, stops listening and clears every timer and watcher; resolves once the
  // server is closed. Safe to call any number of times.
  function close() {
    if (closing) return closing
    closed = true
    stopWork()
    closing = new Promise((resolve) => {
      const force = setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS)
      force.unref()
      server.close(() => {
        clearTimeout(force)
        resolve()
      })
      for (const res of streams.keys()) {
        try {
          res.end()
        } catch {}
      }
      streams.clear()
      server.closeIdleConnections()
    })
    return closing
  }

  return { url: `${origin}/`, port: bound, close, clients: () => streams.size }
}
