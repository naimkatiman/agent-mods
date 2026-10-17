#!/usr/bin/env node
// Hook entry for every agent. Registered as `node D:/Ai/agent-mods/bin/agent-mods-hook.mjs` (Claude settings,
// imported by Grok and Devin Local) and `... --agent codex` (Codex hooks.json).
// Contract: read one JSON payload from stdin, print one reply (or nothing), exit 0. Always.
import { runHook } from '../lib/core/runtime.mjs'

const HARD_CAP_MS = Number(process.env.AGENT_MODS_HOOK_TIMEOUT_MS) || 4000
const watchdog = setTimeout(() => process.exit(0), HARD_CAP_MS)
watchdog.unref()

function readPayload() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('')
    let text = ''
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve(text)
    }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      text += chunk
      // Some agents keep stdin open after the payload line; parse as soon as it is complete. Only a
      // chunk that ends the object can complete it: parsing all text on every 64 KB chunk was
      // quadratic (an 8 MB Write payload took ~1 s).
      if (!/}\s*$/.test(chunk)) return
      try {
        JSON.parse(text.replace(/^\uFEFF/, '').trim())
        finish()
      } catch {}
    })
    process.stdin.on('end', finish)
    process.stdin.on('error', finish)
  })
}

let output = ''
try {
  const stdinText = await readPayload()
  process.stdin.pause()
  output = await runHook({ argv: process.argv.slice(2), env: process.env, stdinText })
} catch {
  output = ''
}
if (output) process.stdout.write(output, () => process.exit(0))
else process.exit(0)
