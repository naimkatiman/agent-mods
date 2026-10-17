// Session records: one JSON file per agent session, written only by that session's hooks (and by the
// session_status tool on its behalf). Every mod that needs "who else is here" reads them through this
// file, so liveness is decided in one place.
//
// Liveness per agent, verified on this host 2026-10-11:
//   claude  <home>/sessions/<pid>.json exists with our sessionId and the pid is alive
//   grok    <home>/active_sessions.json lists our session_id with a live pid (TUI sessions;
//           Devin's ACP Grok sessions never register, so they fall back to the TTL)
//   codex   <home>/thread-writer-locks/<id>.lock is held (reads EBUSY) while a process has the thread
//   devin   %APPDATA%/devin/cli/session_locks/<id>.lock is held while the session is open
// Anything else, or a probe that cannot decide, falls back to "heartbeat within TTL".
import fs from 'node:fs'
import path from 'node:path'
import { isHeldOpenLocked, pidAlive, readJson } from './fsx.mjs'
import { keyOf } from './project.mjs'
import { sessionKey } from './store.mjs'

export const RECORD_VERSION = 1
export const TTL_MS = 30 * 60_000
export const KEEP_MS = 7 * 24 * 3_600_000
// Hook processes and coarse file times disagree by up to a second or two; this covers it with room.
const MTIME_SLACK_MS = 60_000

export function recordRel(key) {
  return `sessions/${key}.json`
}

export function readRecord(store, key) {
  return store.readJson(recordRel(key), null)
}

export function updateRecord(store, key, fn) {
  return store.update(recordRel(key), null, fn)
}

// `since` skips records not written since then without opening them: a stat costs ~0.02 ms on this
// host, an open ~0.8 ms, and hook paths only care about recently active sessions.
export function listRecords(store, { since } = {}) {
  const out = []
  for (const entry of store.list('sessions')) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.includes('.tmp.')) continue
    if (since !== undefined) {
      let mtime = 0
      try {
        mtime = fs.statSync(store.path('sessions', entry.name)).mtimeMs
      } catch {
        continue
      }
      if (mtime < since - MTIME_SLACK_MS) continue
    }
    let record = null
    try {
      record = store.readJson(`sessions/${entry.name}`, null)
    } catch {}
    if (record && record.agent && record.id) {
      record.key = record.key ?? sessionKey(record.agent, record.id)
      out.push(record)
    }
  }
  return out
}

function claudeAlive(record) {
  if (!record.pid || !record.home) return null
  if (!pidAlive(record.pid)) return false
  const reg = readJson(path.join(record.home, 'sessions', `${record.pid}.json`), null)
  if (!reg) return null
  return reg.sessionId ? reg.sessionId === record.id : null
}

function grokAlive(record, cache) {
  if (!record.home) return null
  const file = path.join(record.home, 'active_sessions.json')
  if (!cache.has(file)) cache.set(file, readJson(file, null))
  const list = cache.get(file)
  if (!Array.isArray(list)) return null
  const hit = list.find((s) => s && String(s.session_id) === record.id)
  if (!hit) return null
  return pidAlive(Number(hit.pid))
}

// Held lock = live. Leftover unlocked file = ended. No file = unknown (older engines, such as the
// Codex builds bundled in Devin, may not write these locks), so the caller falls back to the TTL.
function lockAlive(file) {
  try {
    fs.statSync(file)
  } catch {
    return null
  }
  return isHeldOpenLocked(file)
}

function codexAlive(record) {
  if (!record.home) return null
  return lockAlive(path.join(record.home, 'thread-writer-locks', `${record.id}.lock`))
}

function devinAlive(record) {
  if (!record.home) return null
  return lockAlive(path.join(record.home, 'cli', 'session_locks', `${record.id}.lock`))
}

export function probeAlive(record, cache = new Map()) {
  try {
    if (record.agent === 'claude') return claudeAlive(record)
    if (record.agent === 'grok') return grokAlive(record, cache)
    if (record.agent === 'codex') return codexAlive(record)
    if (record.agent === 'devin') return devinAlive(record)
  } catch {}
  return null
}

// Claude's and Grok's probes are pid checks, and Windows reuses pids: a crashed session's registry
// entry plus an unrelated process on its old pid reads as live. So those probes are believed only
// while the session has been active within a day. Codex and Devin probes are held file locks.
const PID_PROBE_TRUST_MS = 24 * 3_600_000

export function isAlive(record, now = Date.now(), cache = new Map()) {
  if (!record || record.endedAt) return false
  const probed = probeAlive(record, cache)
  const idle = now - (record.beatAt ?? 0)
  if (probed === false) return false
  if (probed === true && (idle < PID_PROBE_TRUST_MS || (record.agent !== 'claude' && record.agent !== 'grok'))) return true
  return idle < TTL_MS
}

// Live records, optionally narrowed to one worktree, one repo, or one agent.
export function liveRecords(store, now = Date.now(), { worktreeKey, repoKey, agent, excludeKey } = {}) {
  const cache = new Map()
  return listRecords(store).filter((r) => {
    if (excludeKey && r.key === excludeKey) return false
    if (agent && r.agent !== agent) return false
    if (worktreeKey && keyOf(r.worktreeKey ?? '') !== keyOf(worktreeKey)) return false
    if (repoKey && keyOf(r.repoKey ?? '') !== keyOf(repoKey)) return false
    return isAlive(r, now, cache)
  })
}

// The session an MCP call most likely comes from: an explicit id, the agent's own session env var,
// else the most recently active live session of that agent in that worktree. An explicit id that
// matches no record resolves to nothing: guessing would credit it to another session.
export function resolveCallerSession(store, { agent, sessionId, env = {}, project, now = Date.now() }) {
  const envId =
    agent === 'claude'
      ? env.CLAUDE_CODE_SESSION_ID
      : agent === 'codex'
        ? env.CODEX_THREAD_ID || env.CODEX_SESSION_ID
        : agent === 'grok'
          ? env.GROK_SESSION_ID
          : null
  const id = sessionId || envId
  if (id && agent) {
    const key = sessionKey(agent, id)
    return { agent, id: String(id), key, record: readRecord(store, key) }
  }
  if (id) {
    const match = listRecords(store).find((r) => r.id === String(id))
    return match ? { agent: match.agent, id: match.id, key: match.key, record: match } : null
  }
  const candidates = liveRecords(store, now, { worktreeKey: project?.worktreeKey, agent: agent || undefined })
  candidates.sort((a, b) => (b.beatAt ?? 0) - (a.beatAt ?? 0))
  const best = candidates[0]
  return best ? { agent: best.agent, id: best.id, key: best.key, record: best } : null
}

// `limit` bounds one call's work (removing a session folder costs ~5 ms on this host), so a prune
// that runs inside a SessionStart hook never stalls it; the rest goes on the next run.
export function pruneRecords(store, now = Date.now(), { limit = Infinity } = {}) {
  let removed = 0
  for (const record of listRecords(store)) {
    if (removed >= limit) break
    const last = record.endedAt ?? record.beatAt ?? 0
    if (now - last < KEEP_MS) continue
    store.remove(recordRel(record.key))
    store.remove(`sessions/${record.key}`)
    removed++
  }
  return removed
}
