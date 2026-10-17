// Codex runs a hook only after the user trusts it. Its /hooks screen does that with two app-server
// calls: hooks/list (each hook's key, current hash and trust status) and config/batchWrite (upsert
// hooks.state.<key>.trusted_hash). This module makes the same two calls, limited to the agent-mods
// hooks in each CODEX_HOME, so Codex still computes the hashes and writes config.toml itself.
// Verified against codex 0.162.1 (`codex app-server generate-json-schema`), 2026-10-12.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { MARKER, hookCommand } from './hosts.mjs'
import { CODEX_EVENTS } from './plan.mjs'

const NEEDS_TRUST = new Set(['untrusted', 'modified'])
const CLIENT_INFO = { name: 'agent_mods', title: 'agent-mods', version: '0.1.0' }

const norm = (value) => String(value ?? '').replace(/\\/g, '/').toLowerCase()

// Exactly a hook install wrote into this home's hooks.json: same command, event, matcher and timeout.
// Merely mentioning our script is not enough, or anything that can write hooks.json would get its
// own command trusted without the review /hooks exists for.
export function isOurHook(hook, home) {
  if (hook?.handlerType !== 'command') return false
  if (norm(hook.sourcePath) !== norm(path.join(home, 'hooks.json'))) return false
  if (norm(hook.command) !== norm(hookCommand('codex'))) return false
  const spec = CODEX_EVENTS.find((s) => s.event.toLowerCase() === String(hook.eventName).toLowerCase())
  return Boolean(spec) && (hook.matcher ?? null) === (spec.matcher ?? null) && Number(hook.timeoutSec) === spec.timeout
}

// One app-server session over stdio, one JSON message per line. Closing stdin ends the server
// (measured: exits ~100 ms after EOF, no orphaned codex.exe).
export function openAppServer(home, { spawnImpl = spawn, timeoutMs = 30_000 } = {}) {
  const child = spawnImpl('cmd.exe', ['/d', '/s', '/c', 'codex app-server'], {
    env: { ...process.env, CODEX_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const waiters = new Map()
  let buffer = ''
  let stderr = ''
  let nextId = 1
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      // Server requests and notifications carry a method; only replies settle our calls.
      if (message.method === undefined) waiters.get(message.id)?.(message)
    }
  })
  child.stderr?.on('data', (chunk) => (stderr = `${stderr}${chunk}`.slice(-2000)))
  const failAll = (err) => {
    for (const settle of waiters.values()) settle({ error: { message: err } })
  }
  child.on('error', (err) => failAll(`could not start codex app-server: ${err.message}`))
  child.on('exit', (code) => failAll(`codex app-server exited (${code}): ${stderr.trim().slice(-300)}`))
  return {
    call(method, params) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id)
          reject(new Error(`${method} timed out after ${timeoutMs} ms`))
        }, timeoutMs)
        waiters.set(id, (message) => {
          clearTimeout(timer)
          waiters.delete(id)
          if (message.error) reject(new Error(`${method}: ${message.error.message ?? JSON.stringify(message.error)}`))
          else resolve(message.result)
        })
        child.stdin.write(`${JSON.stringify({ method, id, params })}\n`)
      })
    },
    notify(method) {
      child.stdin.write(`${JSON.stringify({ method })}\n`)
    },
    close() {
      child.stdin.end()
    },
  }
}

// Ours, plus lookalikes: hooks in this home's hooks.json that mention our script but are not what
// install wrote (an edited command). Those are reported and left for the user to review in /hooks.
async function hooksIn(server, home) {
  const reply = await server.call('hooks/list', { cwds: [home] })
  const all = (reply?.data ?? []).flatMap((entry) => entry.hooks ?? [])
  const file = norm(path.join(home, 'hooks.json'))
  return {
    ours: all.filter((hook) => isOurHook(hook, home)),
    lookalikes: all.filter((h) => h?.handlerType === 'command' && norm(h.sourcePath) === file && norm(h.command).includes(MARKER) && !isOurHook(h, home)),
  }
}

function lookalikeNote(list) {
  if (!list.length) return ''
  return `; NOT trusted, changed since install (review in /hooks): ${list.map((h) => `${h.key} runs ${String(h.command).slice(0, 160)}`).join(' | ')}`
}

// For each home: { home, ok, status, hooks: [{ key, event, trust }] }. A failure in one home does
// not stop the others. config.toml is backed up before Codex writes it.
export async function trustCodexHooks({ homes, dryRun = false, open = openAppServer, now = Date.now() }) {
  const results = []
  for (const home of homes) {
    let server = null
    try {
      server = open(home)
      await server.call('initialize', { clientInfo: CLIENT_INFO, capabilities: null })
      server.notify('initialized')
      const { ours, lookalikes } = await hooksIn(server, home)
      const view = (list) => list.map((h) => ({ key: h.key, event: h.eventName, trust: h.trustStatus }))
      const todo = ours.filter((h) => NEEDS_TRUST.has(h.trustStatus))
      const note = lookalikeNote(lookalikes)
      if (!ours.length) {
        results.push({ home, ok: false, status: `no agent-mods hooks (run agent-mods install first)${note}`, hooks: [] })
        continue
      }
      if (!todo.length) {
        results.push({ home, ok: !lookalikes.length, status: `already trusted (${ours.length})${note}`, hooks: view(ours) })
        continue
      }
      if (dryRun) {
        results.push({ home, ok: !lookalikes.length, status: `would trust ${todo.length} of ${ours.length}${note}`, hooks: view(ours) })
        continue
      }
      const config = path.join(home, 'config.toml')
      if (fs.existsSync(config)) fs.copyFileSync(config, `${config}.bak-agent-mods-${now}`)
      await server.call('config/batchWrite', {
        edits: [
          {
            keyPath: 'hooks.state',
            value: Object.fromEntries(todo.map((h) => [h.key, { trusted_hash: h.currentHash }])),
            mergeStrategy: 'upsert',
          },
        ],
        filePath: null,
        expectedVersion: null,
        reloadUserConfig: true,
      })
      const after = (await hooksIn(server, home)).ours
      const left = after.filter((h) => h.trustStatus !== 'trusted')
      results.push({
        home,
        ok: left.length === 0 && !lookalikes.length,
        status: `${left.length ? `${left.length} still not trusted after the write` : `trusted ${todo.length}`}${note}`,
        hooks: view(after),
      })
    } catch (err) {
      results.push({ home, ok: false, status: `failed: ${err?.message ?? err}`, hooks: [] })
    } finally {
      server?.close()
    }
  }
  return results
}
