// The one dashboard per store, for `agent-mods dashboard`: the page's secret and where the running
// server is. "Running" needs a live pid AND /healthz answering with that same pid, because Windows
// reuses pids and a server stopped from outside (TerminateProcess) leaves its instance file behind.
// A live pid whose port takes the connection but does not answer in time is running too, only busy:
// /healthz shares the event loop with the synchronous snapshot build and the actions.
//
// Store:
//   dashboard/token          the page's secret: 24 random bytes as base64url, made once and kept (0600)
//   dashboard/instance.json  { v: 1, pid, port, startedAt }, written by the server process once it
//                            listens (a check-and-write under the file's lock), removed when it stops
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import { pidAlive, safeUnlink, withLock } from '../core/fsx.mjs'
import { CLI_SCRIPT } from '../core/paths.mjs'

// What /healthz says, so a probe can tell our server from anything else holding the port.
export const HEALTH_APP = 'agent-mods-dashboard'
// What probe says of a server that took the connection but sent no full answer in time: the OS
// accepts connections while the server's event loop is held by a long build or action, so busy is
// alive. Only a connection that fails, or never completes, reads as nothing there.
export const BUSY = 'busy'
export const TOKEN_REL = 'dashboard/token'
export const INSTANCE_REL = 'dashboard/instance.json'
export const START_WAIT_MS = 6000
const TOKEN_BYTES = 24
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32}$/
const PROBE_TIMEOUT_MS = 1500
const MAX_HEALTH_BYTES = 4096
const STOP_WAIT_MS = 3000
const POLL_MS = 100
const MAX_PORT = 65_535

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Missing or malformed: null. Unreadable (a scanner holding it on Windows): throws, because making a
// new token then would lock every open page out of a server that still has the old one.
function tokenIn(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  const token = text.trim()
  return TOKEN_SHAPE.test(token) ? token : null
}

// The token as it is on disk, or null: for callers that must not make one (status).
export function readToken(store) {
  try {
    return tokenIn(store.path(TOKEN_REL))
  } catch {
    return null
  }
}

// The token, made on first use. Every writer holds the file's lock, and a reader that catches a
// write half done sees no valid token and waits on that lock, so all processes agree on one token.
export function ensureToken(store) {
  const file = store.path(TOKEN_REL)
  return (
    tokenIn(file) ??
    withLock(file, () => {
      const current = tokenIn(file)
      if (current) return current
      const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url')
      // A damaged file goes first, so the new one is created with mode 0600.
      safeUnlink(file)
      fs.writeFileSync(file, token, { mode: 0o600 })
      return token
    })
  )
}

export function readInstance(store) {
  let raw
  try {
    raw = store.readJson(INSTANCE_REL, null)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const { pid, port, startedAt } = raw
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port) || port <= 0 || port > MAX_PORT) return null
  return { v: 1, pid, port, startedAt: Number.isFinite(startedAt) ? startedAt : null }
}

export function writeInstance(store, { pid, port, startedAt }) {
  store.writeJson(INSTANCE_REL, { v: 1, pid, port, startedAt })
}

const sameInstance = (a, b) => Boolean(a && b) && a.pid === b.pid && a.port === b.port && a.startedAt === b.startedAt

// Records this process as the store's dashboard once it listens: a check-and-write under the file's
// lock, so of two starts that bound at the same moment (the loser of the asked port on a fallback
// one) only the first is recorded and the other knows to stop. Another live pid on record means
// another dashboard got here first, unless it is `seen`, the record this start already found not
// running (a stale file whose pid Windows gave to some other process). Synchronous, like withLock,
// so no probe can run inside the lock. Returns null once written, or the other dashboard's record.
export function claimInstance(store, { pid, port, startedAt }, { seen = null, alive = pidAlive } = {}) {
  return withLock(store.path(INSTANCE_REL), () => {
    const current = readInstance(store)
    if (current && current.pid !== pid && alive(current.pid) && !sameInstance(current, seen)) return current
    writeInstance(store, { pid, port, startedAt })
    return null
  })
}

// Only while the file still names `pid`, so a server that stops never removes a newer one's record.
export function removeInstance(store, pid) {
  const current = readInstance(store)
  if (current && current.pid !== pid) return false
  try {
    store.remove(INSTANCE_REL)
  } catch {}
  return true
}

function healthOf(text, port) {
  try {
    const body = JSON.parse(text)
    if (body?.app !== HEALTH_APP || body.v !== 1 || !Number.isInteger(body.pid) || body.port !== port) return null
    // A server that predates the count reads as having no page open, so the browser opens as before.
    const clients = Number.isInteger(body.clients) && body.clients >= 0 ? body.clients : 0
    return { app: HEALTH_APP, v: 1, pid: body.pid, port, clients }
  } catch {
    return null
  }
}

// GET /healthz on 127.0.0.1:<port>: our server's { app, v, pid, port, clients }; BUSY when the
// connection was accepted but no full answer came within timeoutMs; null for anything else (nothing
// listening, a connection that failed or did not complete in time, another program on the port).
export function probe(port, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let req = null
    let done = false
    let connected = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      req?.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(connected ? BUSY : null), timeoutMs)
    try {
      req = http.request(
        { hostname: '127.0.0.1', port, path: '/healthz', method: 'GET', agent: false, headers: { host: `127.0.0.1:${port}` } },
        (res) => {
          let text = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => {
            text += chunk
            if (text.length > MAX_HEALTH_BYTES) finish(null)
          })
          res.on('end', () => finish(res.statusCode === 200 ? healthOf(text, port) : null))
          res.on('error', () => finish(null))
        },
      )
      // From the moment the OS accepts the connection, silence means a busy server, not a missing one.
      req.on('socket', (socket) => {
        const accepted = () => {
          connected = true
        }
        if (socket.connecting) socket.once('connect', accepted)
        else accepted()
      })
      req.on('error', () => finish(null))
      req.end()
    } catch {
      finish(null)
    }
  })
}

// This store's running dashboard, or null: { v, pid, port, startedAt, busy, clients }. busy: its pid
// is alive and its port took the connection but did not answer in time, so clients (the pages it
// streams to) is unknown, null. Busy is still running: nothing may start over it or forget it.
export async function findRunning(store, { alive = pidAlive, probeFn = probe } = {}) {
  const instance = readInstance(store)
  if (!instance || !alive(instance.pid)) return null
  const health = await probeFn(instance.port)
  if (health === BUSY) return { ...instance, busy: true, clients: null }
  return health?.pid === instance.pid ? { ...instance, busy: false, clients: health.clients ?? 0 } : null
}

// Starts `agent-mods dashboard --foreground` as a detached, hidden node process (on Windows a child
// that is not detached dies with this CLI) and waits for it to answer. Its folder is the home folder,
// so it never holds a project folder open (Windows refuses to delete a process's current folder).
// Returns the running instance, or null once the child exits or waitMs passes without one.
export async function startDetached({ store, port, env = process.env, spawner = spawn, waitMs = START_WAIT_MS } = {}) {
  let exited = false
  try {
    const args = [CLI_SCRIPT, 'dashboard', '--foreground', '--no-open', '--port', String(port)]
    const child = spawner(process.execPath, args, { cwd: os.homedir(), detached: true, stdio: 'ignore', windowsHide: true, env })
    child.on('error', () => {
      exited = true
    })
    child.on('exit', () => {
      exited = true
    })
    child.unref()
  } catch {
    return null
  }
  const deadline = Date.now() + waitMs
  for (;;) {
    const running = await findRunning(store)
    if (running) return running
    // A child that lost a start race to another dashboard exits after finding it, so look once more.
    if (exited) return findRunning(store)
    if (Date.now() >= deadline) return null
    await sleep(POLL_MS)
  }
}

// Stops this store's dashboard. The pid is killed only while it is alive and its port either answers
// /healthz with that pid (a reused pid belongs to someone else) or takes the connection without
// answering (busy). Then it waits for the pid to exit and only then removes the file: a busy server
// is never forgotten while it runs, and one that will not die stays on record ('stuck').
// Returns { status: 'stopped' | 'not-running' | 'stuck', pid }.
export async function stopInstance(store, { alive = pidAlive, kill = (pid) => process.kill(pid), probeFn = probe, waitMs = STOP_WAIT_MS } = {}) {
  const instance = readInstance(store)
  if (!instance) return { status: 'not-running', pid: null }
  const { pid } = instance
  const health = alive(pid) ? await probeFn(instance.port) : null
  if (health !== BUSY && health?.pid !== pid) {
    removeInstance(store, pid)
    return { status: 'not-running', pid }
  }
  try {
    kill(pid)
  } catch (err) {
    if (err?.code !== 'ESRCH') return { status: 'stuck', pid }
  }
  const deadline = Date.now() + waitMs
  while (alive(pid) && Date.now() < deadline) await sleep(POLL_MS)
  if (alive(pid)) return { status: 'stuck', pid }
  removeInstance(store, pid)
  return { status: 'stopped', pid }
}
