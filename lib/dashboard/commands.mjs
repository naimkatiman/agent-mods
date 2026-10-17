// The `agent-mods dashboard` command. Plain `dashboard` starts the server in the background (or finds
// the running one), opens the browser on it unless a page already shows it, and prints the link with
// its token, then returns, so it works from a terminal and from an agent's shell tool alike.
// `--foreground` is the server itself in this process (the background start runs exactly that,
// detached); `stop` and `status` manage it. node:http and the server load only when the command
// runs, so every other command stays as quick.
//
// Store: dashboard/token and dashboard/instance.json, through instance.mjs.
import { logError } from '../core/store.mjs'
import { agoText } from '../core/text.mjs'

const DEFAULT_PORT = 4747
const MIN_PORT = 1024
const MAX_PORT = 65_535
// After EADDRINUSE, how long a dashboard that won a start race gets to record itself before this one
// moves to another port instead.
const RACE_WAIT_MS = 1000
const POLL_MS = 100
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK']
const SUBCOMMANDS = ['stop', 'status']

const USAGE = [
  'Usage: agent-mods dashboard [--port 4747] [--no-open | --open] [--json]    start in the background (or reuse), open the browser',
  '       agent-mods dashboard --foreground [--port 4747] [--no-open]   run in this terminal (Ctrl+C stops)',
  '       agent-mods dashboard stop | status [--json]',
  '',
  'A dashboard already open in a browser tab is not opened again; --open opens another tab anyway.',
].join('\n')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const linkOf = (port, token) => `http://127.0.0.1:${port}/${token ? `?t=${token}` : ''}`

function usage(c, problem) {
  c.error(problem)
  c.error(USAGE)
  return 2
}

// 0 asks the OS for a free port. Below 1024 is refused: those ports need admin rights on POSIX, and a
// browser leaves port 80 out of the Host and Origin headers the server checks.
function portOf(value) {
  if (value === undefined) return DEFAULT_PORT
  if (typeof value !== 'string' || !/^\d{1,5}$/.test(value)) return null
  const port = Number(value)
  return port === 0 || (port >= MIN_PORT && port <= MAX_PORT) ? port : null
}

async function openPage(c, url, browser) {
  if (c.flags['no-open']) return false
  const open = browser ?? (await import('../mods/design-server.mjs')).openBrowser
  return open(url, c.env)
}

function failed(c, err) {
  logError(c.store, `dashboard: start: ${err?.stack ?? err}`)
  c.error(`The dashboard could not start: ${err?.message ?? err}`)
  return 1
}

function alreadyRunning(c, instance, running) {
  c.error(`The dashboard is already running (pid ${running.pid}): ${linkOf(running.port, instance.readToken(c.store))}`)
  c.error('Stop it first with `agent-mods dashboard stop`.')
  return 1
}

async function waitForRunning(instance, store, ms) {
  const deadline = Date.now() + ms
  for (;;) {
    const running = await instance.findRunning(store)
    if (running || Date.now() >= deadline) return running
    await sleep(POLL_MS)
  }
}

function tokenOf(c, instance) {
  try {
    return instance.ensureToken(c.store)
  } catch (err) {
    failed(c, err)
    return null
  }
}

async function background(c, instance, { port, spawner, browser }) {
  // Made before the server starts, so this process and the server agree on it.
  const token = tokenOf(c, instance)
  if (!token) return 1
  // A busy server counts as running: starting another would leave two, one of them unrecorded.
  let running = await instance.findRunning(c.store)
  const started = !running
  if (!running) running = await instance.startDetached({ store: c.store, port, env: c.env, spawner })
  if (!running) {
    c.error(`The dashboard did not start within ${instance.START_WAIT_MS / 1000} s. Run \`agent-mods dashboard --foreground\` to see why.`)
    return 1
  }
  const url = linkOf(running.port, token)
  // Every tab holds one event stream, and a browser allows 6 connections per host: from the 7th tab
  // on, pages and actions stall. So a page already open is pointed at, not opened again, unless
  // --open asks for another tab. A busy server could not say (clients null): it opens as before.
  const alreadyOpen = running.clients > 0
  const opened = alreadyOpen && !c.flags.open ? false : await openPage(c, url, browser)
  if (c.json) {
    c.printJson({ url, pid: running.pid, port: running.port, started, opened, alreadyOpen })
    return 0
  }
  if (started) c.print(`Started the dashboard in the background (pid ${running.pid}); \`agent-mods dashboard stop\` stops it.`)
  else if (alreadyOpen && !opened) c.print(`The dashboard (pid ${running.pid}) is already open in a browser tab; \`--open\` opens another tab.`)
  else c.print(`The dashboard is already running (pid ${running.pid}).`)
  c.print(url)
  return 0
}

// The server in this process, until Ctrl+C (SIGINT), Ctrl+Break (SIGBREAK) or SIGTERM. The instance
// file is written once it listens and removed when it stops; a kill from outside cannot remove it,
// which is why findRunning also asks /healthz.
async function foreground(c, instance, { port, server: extra, browser }) {
  // The record as this start found it. If it is not running (a stale file) it may be replaced; any
  // other that appears while this server starts belongs to a dashboard that started first.
  const seen = instance.readInstance(c.store)
  const other = await instance.findRunning(c.store)
  if (other) return alreadyRunning(c, instance, other)
  const token = tokenOf(c, instance)
  if (!token) return 1
  const { startDashboard } = await import('./server.mjs')
  const listen = (at) => startDashboard({ store: c.store, env: c.env, port: at, token, ...extra })
  let server
  try {
    server = await listen(port)
  } catch (err) {
    if (err?.code !== 'EADDRINUSE' || port === 0) return failed(c, err)
    // Two starts at once: the winner records itself right after it listens, so wait for it briefly.
    const winner = await waitForRunning(instance, c.store, RACE_WAIT_MS)
    if (winner) return alreadyRunning(c, instance, winner)
    try {
      server = await listen(0)
    } catch (error) {
      return failed(c, error)
    }
  }
  // Two starts that both waited out the race above both get here, each on its own port: only the
  // first to record itself stays, so no dashboard runs that `stop` and `status` cannot see.
  let ahead
  try {
    ahead = instance.claimInstance(c.store, { pid: process.pid, port: server.port, startedAt: Date.now() }, { seen })
  } catch (err) {
    await server.close()
    return failed(c, err)
  }
  if (ahead) {
    await server.close()
    return alreadyRunning(c, instance, ahead)
  }
  const url = linkOf(server.port, token)
  if (c.json) c.printJson({ url, pid: process.pid, port: server.port })
  else {
    c.print(`The dashboard is running in this terminal (pid ${process.pid}); Ctrl+C stops it.`)
    c.print(url)
  }
  await openPage(c, url, browser)
  return new Promise((resolve) => {
    let stopped = false
    const forget = () => instance.removeInstance(c.store, process.pid)
    const stop = () => {
      if (stopped) return
      stopped = true
      for (const name of SIGNALS) process.off(name, stop)
      process.off('exit', forget)
      forget()
      server.close().then(() => resolve(0))
    }
    for (const name of SIGNALS) process.on(name, stop)
    // A crash still takes the record with it.
    process.on('exit', forget)
  })
}

async function status(c, instance) {
  const running = await instance.findRunning(c.store)
  if (!running) {
    if (c.json) c.printJson({ running: false })
    else c.print('The dashboard is not running. `agent-mods dashboard` starts it.')
    return 1
  }
  const url = linkOf(running.port, instance.readToken(c.store))
  if (c.json) {
    c.printJson({ running: true, pid: running.pid, port: running.port, startedAt: running.startedAt, url })
    return 0
  }
  const since = running.startedAt ? `, started ${agoText(running.startedAt, c.now)}` : ''
  c.print(`The dashboard is running (pid ${running.pid}, port ${running.port}${since}).`)
  c.print(url)
  return 0
}

async function stop(c, instance) {
  const result = await instance.stopInstance(c.store)
  if (c.json) c.printJson(result)
  else if (result.status === 'stopped') c.print(`Stopped the dashboard (pid ${result.pid}).`)
  else if (result.status === 'not-running') c.print('The dashboard is not running.')
  else c.error(`The dashboard (pid ${result.pid}) did not stop; it is still running.`)
  return result.status === 'stuck' ? 1 : 0
}

// deps are test seams: server (more startDashboard options, such as fakes for the data modules),
// spawner (what starts the background process) and browser (what opens a tab, openBrowser).
export async function runDashboard(c, { server = {}, spawner, browser } = {}) {
  const [sub] = c.positionals
  if (c.positionals.length > 1 || (sub !== undefined && !SUBCOMMANDS.includes(sub))) {
    return usage(c, `Unknown: agent-mods dashboard ${c.positionals.join(' ')}`)
  }
  const instance = await import('./instance.mjs')
  if (sub === 'status') return status(c, instance)
  if (sub === 'stop') return stop(c, instance)
  const port = portOf(c.flags.port)
  if (port === null) return usage(c, `--port takes 0 (any free port) or a number from ${MIN_PORT} to ${MAX_PORT}.`)
  if (c.flags.foreground) return foreground(c, instance, { port, server, browser })
  return background(c, instance, { port, spawner, browser })
}

export const DASHBOARD_COMMANDS = [
  {
    name: 'dashboard',
    summary: 'Open the live page of every agent session in your browser (stop, status)',
    usage: USAGE,
    run: (c) => runDashboard(c),
  },
]
