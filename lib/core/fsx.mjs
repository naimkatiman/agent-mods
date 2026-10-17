// Small, synchronous file helpers shared by hooks, the MCP server and the CLI.
// Hooks are short-lived processes on a hot path, so everything here is sync, bounded and
// tolerant of other processes (four agents, many sessions) touching the same files.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4))

export function sleepSync(ms) {
  Atomics.wait(SLEEP_CELL, 0, 0, ms)
}

export function safeName(value, max = 120) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, max) || '_'
}

export function sha1(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex')
}

export function randomId(bytes = 4) {
  return crypto.randomBytes(bytes).toString('hex')
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

// Missing file -> fallback. A half-written file (another process mid-write, or Windows'
// in-place fallback write) gets one short retry before falling back.
export function readJson(file, fallback = null) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return fallback
      if (attempt === 0 && (err.code === 'EBUSY' || err.code === 'EPERM')) {
        sleepSync(15)
        continue
      }
      throw err
    }
    try {
      return JSON.parse(text.replace(/^﻿/, ''))
    } catch {
      if (attempt === 0) sleepSync(15)
    }
  }
  return fallback
}

// Temp file + rename. Rename over a file that another process holds open can fail on Windows
// (EPERM/EBUSY/EACCES), so retry, then fall back to a direct write.
export function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file))
  const text = `${JSON.stringify(data, null, 2)}\n`
  const tmp = `${file}.tmp.${process.pid}.${randomId()}`
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES', 'EEXIST'].includes(err.code)) {
        safeUnlink(tmp)
        throw err
      }
      sleepSync(15 * (attempt + 1))
    }
  }
  try {
    fs.writeFileSync(file, text, { mode: 0o600 })
  } finally {
    safeUnlink(tmp)
  }
}

export function safeUnlink(file) {
  try {
    fs.unlinkSync(file)
  } catch {}
}

export class LockTimeout extends Error {
  constructor(file) {
    super(`agent-mods: lock timeout on ${file}`)
    this.code = 'ELOCKTIMEOUT'
  }
}

// While another process removes the lock, Windows answers mkdir with EPERM/EACCES/EBUSY: held, not fatal.
const LOCK_HELD = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY'])

// A lock left by a killed hook: its owner pid is gone (broken at once), or it is older than staleMs.
// It is renamed away before removal, so of several waiters only one breaks it.
function breakAbandoned(lockDir, staleMs) {
  let owner = NaN
  try {
    owner = Number(fs.readFileSync(path.join(lockDir, 'owner'), 'utf8'))
  } catch {}
  let age
  try {
    age = Date.now() - fs.statSync(lockDir).mtimeMs
  } catch {
    return true
  }
  const ownerGone = Number.isInteger(owner) && owner > 0 && !pidAlive(owner)
  if (!ownerGone && age <= staleMs) return false
  const aside = `${lockDir}.stale-${process.pid}-${randomId()}`
  try {
    fs.renameSync(lockDir, aside)
  } catch {
    return false
  }
  try {
    fs.rmSync(aside, { recursive: true, force: true })
  } catch {}
  return true
}

// mkdir is atomic on NTFS and POSIX. The lock records its owner pid; see breakAbandoned.
export function withLock(file, fn, { timeoutMs = 1500, staleMs = 10_000, mkdir = fs.mkdirSync } = {}) {
  const lockDir = `${file}.lock`
  ensureDir(path.dirname(file))
  const deadline = Date.now() + timeoutMs
  let wait = 5
  for (;;) {
    try {
      mkdir(lockDir)
      try {
        fs.writeFileSync(path.join(lockDir, 'owner'), String(process.pid))
      } catch {}
      break
    } catch (err) {
      if (!LOCK_HELD.has(err.code)) throw err
      if (err.code === 'EEXIST' && breakAbandoned(lockDir, staleMs)) continue
      if (Date.now() >= deadline) throw new LockTimeout(file)
      sleepSync(wait)
      wait = Math.min(wait * 2, 40)
    }
  }
  try {
    return fn()
  } finally {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true })
    } catch {}
  }
}

// Read-modify-write under the file's lock. fn receives the current value (or the fallback)
// and returns the next value; returning undefined leaves the file untouched.
export function updateJson(file, fallback, fn, lockOptions) {
  return withLock(
    file,
    () => {
      const current = readJson(file, structuredClone(fallback))
      const next = fn(current)
      if (next !== undefined) writeJsonAtomic(file, next)
      return next === undefined ? current : next
    },
    lockOptions,
  )
}

// One line per call, one write per line: concurrent appenders interleave whole lines.
export function appendJsonLine(file, value) {
  ensureDir(path.dirname(file))
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`)
}

export function readJsonLines(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {}
  }
  return out
}

export function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}

export function removePath(target) {
  fs.rmSync(target, { recursive: true, force: true })
}

// A file another process holds a byte-range lock on reads as EBUSY on Windows. Codex
// (thread-writer-locks) and Devin (session_locks) mark live sessions that way.
export function isHeldOpenLocked(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
  } catch (err) {
    return err.code === 'EBUSY' ? true : null
  }
  try {
    fs.readSync(fd, Buffer.alloc(1), 0, 1, 0)
    return false
  } catch (err) {
    return err.code === 'EBUSY' ? true : null
  } finally {
    fs.closeSync(fd)
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}
