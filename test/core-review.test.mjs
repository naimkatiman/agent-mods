// Fixes from the 2026-10-12 adversarial review of the core.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { clip, sanitize } from '../lib/core/text.mjs'
import { fitContext, normalizeEvent, patchedFiles, renderOutput } from '../lib/core/agents.mjs'
import { capturePayload } from '../lib/core/capture.mjs'
import { makeRepo, mcpClient, payloadFor, tempStore } from './helpers.mjs'

const ROCKET = '\u{1F680}'
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

test('clip, sanitize and fitContext never cut an emoji in half', () => {
  assert.ok(clip(`${'a'.repeat(38)}${ROCKET}x`, 40).isWellFormed())
  assert.ok(sanitize(`${'a'.repeat(38)}${ROCKET}x`, 40).isWellFormed())
  assert.ok(fitContext([`${'b'.repeat(6000)}${ROCKET}${'c'.repeat(3000)}`, 'short']).isWellFormed())
})

test('no hook reply or MCP result carries a lone surrogate, whatever a mod hands it', async () => {
  const broken = `title ${ROCKET.slice(0, 1)}… rest`
  for (const agent of ['claude', 'codex', 'devin']) {
    const raw = renderOutput(agent, 'SessionStart', { context: broken, notice: broken })
    assert.doesNotMatch(raw, /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i, agent)
    assert.ok(!LONE.test(JSON.parse(raw).hookSpecificOutput.additionalContext), agent)
  }
  const { env } = tempStore()
  const probe = { name: 'probe', tools: [{ name: 'probe_tool', description: 'returns broken text', inputSchema: { type: 'object', properties: {} }, run: () => ({ text: broken, data: { title: broken } }) }] }
  const client = mcpClient({ mods: [probe], env, clientName: 'codex-mcp-client' })
  try {
    await client.init()
    const result = await client.tool('probe_tool')
    assert.ok(!LONE.test(result.content[0].text))
    assert.ok(!LONE.test(result.data.title))
  } finally {
    client.close()
  }
})

test('sanitize strips C1 controls and bidi overrides as well as C0', () => {
  assert.equal(sanitize('a\u001b[31mb\u009b31mc‮d⁦e'), 'a[31mb31mcde')
})

test('patchedFiles stays fast on a pathological header line', () => {
  const started = Date.now()
  const files = patchedFiles(`*** Begin Patch\n*** Add File: a${' '.repeat(65_536)}b\n*** Update File: src/x.ts  \r\n*** Move to: src/y.ts\n*** End Patch\n`)
  assert.ok(Date.now() - started < 100, `took ${Date.now() - started} ms`)
  assert.deepEqual(files, [
    { path: 'src/x.ts', op: 'update' },
    { path: 'src/y.ts', op: 'move' },
  ])
})

test('payload capture keeps keys and lengths, not free text', () => {
  const { store, root } = tempStore()
  const cwd = makeRepo('capture')
  const fixture = '000000000:' + 'SYNTHETIC_fixture_0123456789'.repeat(2)
  const payload = payloadFor('claude', 'PostToolUse', { tool: 'todo', todos: [{ text: `Rotating BOT_TOKEN ${fixture}`, status: 'in_progress' }] }, { cwd })
  capturePayload(store, normalizeEvent('claude', payload, {}), {})
  const dir = path.join(root, 'logs', 'payloads')
  const saved = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
  assert.doesNotMatch(saved, /SYNTHETIC_fixture|Rotating/)
  assert.match(saved, /TodoWrite/, 'structural values such as the tool name stay')
})
