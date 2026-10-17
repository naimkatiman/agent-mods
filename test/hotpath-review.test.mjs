// Fixes from the 2026-10-12 adversarial review of the hook hot path.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { withLock } from '../lib/core/fsx.mjs'
import { isAlive, pruneRecords } from '../lib/core/session-records.mjs'
import { tempDir, tempStore } from './helpers.mjs'

const DEAD_PID = 2147483644

test('withLock breaks a lock whose owner process is gone at once, not after staleMs', () => {
  const file = path.join(tempDir('am-lock-'), 'state.json')
  fs.mkdirSync(`${file}.lock`)
  fs.writeFileSync(path.join(`${file}.lock`, 'owner'), String(DEAD_PID))
  const started = Date.now()
  assert.equal(withLock(file, () => 'ran', { timeoutMs: 300 }), 'ran')
  assert.ok(Date.now() - started < 250, `waited ${Date.now() - started} ms`)
  assert.equal(fs.existsSync(`${file}.lock`), false)
})

test('withLock still waits for a live owner, then times out', () => {
  const file = path.join(tempDir('am-lock-'), 'state.json')
  fs.mkdirSync(`${file}.lock`)
  fs.writeFileSync(path.join(`${file}.lock`, 'owner'), String(process.pid))
  assert.throws(() => withLock(file, () => 'ran', { timeoutMs: 100 }), /lock timeout/)
})

test('withLock treats a transient Windows EPERM on mkdir as a held lock and retries', () => {
  const file = path.join(tempDir('am-lock-'), 'state.json')
  let calls = 0
  const mkdir = (dir) => {
    if (++calls < 3) throw Object.assign(new Error('EPERM: operation not permitted, mkdir'), { code: 'EPERM' })
    fs.mkdirSync(dir)
  }
  assert.equal(withLock(file, () => 'ran', { timeoutMs: 500, mkdir }), 'ran')
  assert.equal(calls, 3)
})

test('pruneRecords removes at most `limit` records per call', () => {
  const { store } = tempStore()
  const old = Date.now() - 30 * 24 * 3_600_000
  for (let i = 0; i < 10; i++) store.writeJson(`sessions/claude__old-${i}.json`, { agent: 'claude', id: `old-${i}`, beatAt: old, endedAt: old })
  assert.equal(pruneRecords(store, Date.now(), { limit: 4 }), 4)
  assert.equal(pruneRecords(store, Date.now()), 6)
})

test('a live pid in a stale Claude registry entry does not keep a two-day-old session alive', () => {
  const home = tempDir('am-claude-home-')
  fs.mkdirSync(path.join(home, 'sessions'))
  const record = { agent: 'claude', id: 'crashed-1', home, pid: process.pid, beatAt: Date.now() - 2 * 24 * 3_600_000 }
  fs.writeFileSync(path.join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'crashed-1' }))
  assert.equal(isAlive(record, Date.now()), false, 'Windows reused the pid; the session crashed two days ago')
  assert.equal(isAlive({ ...record, beatAt: Date.now() - 3 * 3_600_000 }, Date.now()), true, 'a probe is still believed for a session active today')
})
