// End to end: the real entry points as separate processes, the way agents run them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { envFor, makeRepo, payloadFor, tempStore } from './helpers.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const HOOK = path.join(ROOT, 'bin', 'agent-mods-hook.mjs')
const MCP = path.join(ROOT, 'bin', 'mcp-server.mjs')
const CLI = path.join(ROOT, 'bin', 'agent-mods.mjs')

export const EXPECTED_TOOLS = [
  'sessions', 'session_status', 'send_message', 'briefing',
  'log_assumption', 'assumptions',
  'design_pick', 'design_decisions',
  'plain',
  'shelve_idea', 'ideas',
  'enhance',
  'clawd',
]

function runHookProcess(agent, event, fields, { cwd, env }) {
  const payload = payloadFor(agent, event, fields, { cwd })
  const started = Date.now()
  const r = spawnSync(process.execPath, [HOOK, ...(agent === 'codex' ? ['--agent', 'codex'] : [])], {
    input: JSON.stringify(payload),
    env: { ...process.env, ...envFor(agent, { cwd, base: env }), AGENT_MODS_NO_BROWSER: '1' },
    encoding: 'utf8',
    timeout: 15_000,
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - started }
}

test('hook process: every agent, every registered event, exits 0 with valid JSON or nothing', () => {
  const { env, root } = tempStore()
  const cwd = makeRepo('e2e')
  const file = path.join(cwd, 'src', 'a.ts')
  const plan = [
    ['SessionStart', {}],
    ['UserPromptSubmit', { prompt: 'fix the login form validation' }],
    ['PostToolUse', { tool: 'edit', file }],
    ['PostToolUse', { tool: 'todo', todos: [{ text: 'fix login', status: 'in_progress' }] }],
    ['Stop', { answer: 'Done.\n\nFixed the validation in src/a.ts.' }],
    ['Notification', { message: 'Claude needs your permission' }],
    ['SessionEnd', {}],
  ]
  for (const agent of ['claude', 'codex', 'grok', 'devin']) {
    for (const [event, fields] of plan) {
      if (event === 'Notification' && (agent === 'codex' || agent === 'devin')) continue
      const r = runHookProcess(agent, event, fields, { cwd, env })
      assert.equal(r.code, 0, `${agent} ${event}: exit ${r.code} ${r.stderr}`)
      assert.equal(r.stderr, '', `${agent} ${event} wrote stderr: ${r.stderr}`)
      if (r.stdout) {
        const reply = JSON.parse(r.stdout)
        if (agent === 'codex') {
          const allowed = new Set(['hookSpecificOutput', 'systemMessage', 'decision', 'reason'])
          for (const key of Object.keys(reply)) assert.ok(allowed.has(key), `codex ${event}: unexpected key ${key}`)
          if (reply.hookSpecificOutput) {
            assert.equal(reply.hookSpecificOutput.hookEventName, event)
            assert.deepEqual(Object.keys(reply.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName'])
          }
        }
        if (agent === 'grok') assert.ok(!['SessionStart', 'UserPromptSubmit', 'SessionEnd', 'Notification'].includes(event), `grok ${event} printed output Grok discards`)
      }
    }
  }
  const errors = path.join(root, 'logs', 'errors.log')
  assert.equal(fs.existsSync(errors) ? fs.readFileSync(errors, 'utf8') : '', '', 'no errors logged')
  const records = fs
    .readdirSync(path.join(root, 'sessions'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(root, 'sessions', f), 'utf8')))
    .filter((r) => r.agent && r.id)
  assert.deepEqual(records.map((r) => r.agent).sort(), ['claude', 'codex', 'devin', 'grok'], 'one session record per agent')
  for (const r of records) {
    assert.equal(r.state, 'ended', `${r.agent} ended`)
    assert.ok(r.files?.some((f) => f.endsWith('a.ts')), `${r.agent} recorded the edit`)
  }
})

test('hook process: garbage stdin and an empty payload exit 0 silently', () => {
  const { env } = tempStore()
  for (const input of ['', 'not json', '{}', '[]']) {
    const r = spawnSync(process.execPath, [HOOK], { input, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10_000 })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
  }
})

test('mcp process: initialize, all 13 tools listed with valid schemas, unknown method error', async () => {
  const { env } = tempStore()
  const child = spawn(process.execPath, [MCP], { env: { ...process.env, ...env, AGENT_MODS_NO_BROWSER: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''
  const waiters = new Map()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      waiters.get(msg.id)?.(msg)
    }
  })
  let id = 0
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const my = ++id
      const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 10_000)
      waiters.set(my, (m) => {
        clearTimeout(timer)
        resolve(m)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: my, method, params })}\n`)
    })
  try {
    const init = await call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'grok', version: '1' }, capabilities: {} })
    assert.equal(init.result.serverInfo.name, 'agent-mods')
    assert.ok(init.result.instructions.includes('log_assumption'))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const list = await call('tools/list', {})
    const names = list.result.tools.map((t) => t.name)
    assert.deepEqual([...names].sort(), [...EXPECTED_TOOLS].sort())
    for (const t of list.result.tools) {
      assert.ok(/^[a-z][a-z0-9_]*$/.test(t.name) && !t.name.includes('__'), `tool name ${t.name}`)
      assert.equal(t.inputSchema?.type, 'object', `${t.name} schema type`)
      assert.ok(typeof t.description === 'string' && t.description.length > 10 && t.description.length < 1200, `${t.name} description`)
      JSON.stringify(t.inputSchema)
    }
    const schemaBytes = JSON.stringify(list.result.tools).length
    assert.ok(schemaBytes < 24_000, `tool schemas cost ${schemaBytes} bytes of every agent's context`)
    const bad = await call('nope/nope', {})
    assert.equal(bad.error.code, -32601)
    const res = await call('resources/list', {})
    assert.deepEqual(res.result.resources, [])
  } finally {
    child.kill()
  }
})

test('cli process: help lists every mod command', () => {
  const r = spawnSync(process.execPath, [CLI, 'help'], { encoding: 'utf8', env: { ...process.env, AGENT_MODS_HOME: tempStore().root } })
  assert.equal(r.status, 0)
  for (const name of ['sessions', 'assumptions', 'design', 'plain', 'notify', 'idea', 'enhance', 'clawd', 'install', 'doctor', 'dashboard']) {
    assert.match(r.stdout, new RegExp(`\\n  ${name}\\b`), `help mentions ${name}`)
  }
})

test('skills: every SKILL.md has valid frontmatter for all four agents', () => {
  const dir = path.join(ROOT, 'skills')
  const names = fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, 'SKILL.md')))
  assert.deepEqual(names.sort(), ['assumptions', 'clawd', 'design-decisions', 'enhance', 'idea', 'monitor', 'plain', 'tracker'])
  for (const name of names) {
    const text = fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8')
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)
    assert.ok(fm, `${name}: frontmatter`)
    const nameLine = /^name:\s*(.+)$/m.exec(fm[1])
    const desc = /^description:\s*(.+)$/m.exec(fm[1])
    assert.equal(nameLine?.[1].trim().replace(/^['"]|['"]$/g, ''), name, `${name}: name matches folder`)
    assert.ok(/^[a-z0-9-]{1,64}$/.test(name), `${name}: hyphen-case`)
    const d = desc?.[1].trim().replace(/^['"]|['"]$/g, '') ?? ''
    assert.ok(d.length > 20 && d.length <= 1024, `${name}: description length ${d.length}`)
    assert.ok(!/[<>]/.test(d), `${name}: no < or > in description (Codex validator)`)
    assert.match(text, /agent-mods /, `${name}: has a CLI fallback`)
  }
})
