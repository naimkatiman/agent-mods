import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { canonicalPath, keyOf, projectInfo, relativeTo } from '../lib/core/project.mjs'
import { MAX_CONTEXT_CHARS, detectAgent, fitContext, normalizeEvent, patchedFiles, renderOutput } from '../lib/core/agents.mjs'
import { readJson, updateJson, writeJsonAtomic, withLock } from '../lib/core/fsx.mjs'
import { makeCliContext, parseArgs, runCli } from '../lib/core/cli.mjs'
import { listRecords, resolveCallerSession } from '../lib/core/session-records.mjs'
import { contextOf, hook, makeRepo, makeWorktree, mcpClient, payloadFor, tempStore } from './helpers.mjs'

const IS_WIN = process.platform === 'win32'

test('canonicalPath folds every spelling of one Windows path to one key', { skip: !IS_WIN }, () => {
  const spellings = [
    'D:\\Sample Telegram Projects\\SampleApp',
    'd:\\Sample Telegram Projects\\SampleApp\\',
    'd:/Sample Telegram Projects/SampleApp',
    '\\\\?\\D:\\Sample Telegram Projects\\SampleApp',
    '/d/Sample Telegram Projects/SampleApp',
    'd:\\sample telegram projects\\sampleapp',
  ]
  const keys = new Set(spellings.map((s) => keyOf(canonicalPath(s))))
  assert.equal(keys.size, 1)
  assert.equal(canonicalPath('D:\\Sample Telegram Projects\\SampleApp'), 'd:/Sample Telegram Projects/SampleApp')
})

test('relativeTo gives a worktree-relative key regardless of case and slashes', () => {
  const root = canonicalPath(path.resolve('/tmp/shop'))
  assert.equal(relativeTo(root, path.join(root, 'src', 'auth.ts')), 'src/auth.ts')
  if (IS_WIN) assert.equal(relativeTo(root, path.join(root, 'SRC', 'Auth.ts').toUpperCase()), 'SRC/AUTH.TS')
})

test('projectInfo: a linked worktree shares the repo and project id but not the worktree key', () => {
  const main = makeRepo('shop')
  const wt = makeWorktree(main, 'feature')
  const a = projectInfo(path.join(main, 'src'))
  const b = projectInfo(wt)
  assert.equal(a.projectId, b.projectId)
  assert.equal(keyOf(a.repoKey), keyOf(b.repoKey))
  assert.notEqual(keyOf(a.worktreeKey), keyOf(b.worktreeKey))
  assert.equal(a.name, 'shop')
  assert.ok(a.isRepo && b.isRepo)
})

test('projectInfo outside a repo keys the folder itself', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'am-norepo-'))
  const info = projectInfo(dir)
  assert.equal(info.isRepo, false)
  assert.equal(info.repoKey, info.worktreeKey)
})

test('detectAgent: explicit flag, Grok env/payload, Devin env, Codex payload, Claude default', () => {
  assert.equal(detectAgent({ argv: ['--agent', 'codex'] }), 'codex')
  assert.equal(detectAgent({ env: { GROK_HOOK_EVENT: 'stop' } }), 'grok')
  assert.equal(detectAgent({ payload: { hookEventName: 'stop', sessionId: 'x' } }), 'grok')
  assert.equal(detectAgent({ env: { DEVIN_PROJECT_DIR: 'd:/x', CLAUDE_PROJECT_DIR: 'd:/x' } }), 'devin')
  assert.equal(detectAgent({ payload: { turn_id: 't', transcript_path: 'C:/u/.codex/sessions/2026/10/11/rollout-x.jsonl' } }), 'codex')
  assert.equal(detectAgent({ env: { CLAUDE_PROJECT_DIR: 'd:/x' }, payload: { session_id: 'x' } }), 'claude')
  // Grok sets CLAUDE_PROJECT_DIR too; Grok must win.
  assert.equal(detectAgent({ env: { GROK_HOOK_EVENT: 'x', CLAUDE_PROJECT_DIR: 'd:/x' } }), 'grok')
})

test('normalizeEvent reads Grok camelCase and maps its edit tool', () => {
  const cwd = makeRepo('g')
  const ev = normalizeEvent('grok', payloadFor('grok', 'PostToolUse', { tool: 'edit', file: path.join(cwd, 'src', 'a.ts') }, { cwd }), {})
  assert.equal(ev.event, 'PostToolUse')
  assert.equal(ev.sessionId, '33333333-3333-4333-8333-333333333333')
  assert.equal(ev.toolName, 'search_replace')
  assert.equal(ev.toolKind, 'edit')
  assert.equal(ev.edits.length, 1)
  assert.ok(ev.edits[0].path.endsWith('/src/a.ts'))
})

test('normalizeEvent parses Codex apply_patch file headers relative to cwd', () => {
  const cwd = makeRepo('c')
  const ev = normalizeEvent('codex', payloadFor('codex', 'PostToolUse', { tool: 'edit', file: 'src/b.ts' }, { cwd }), {})
  assert.equal(ev.edits.length, 1)
  assert.equal(keyOf(ev.edits[0].path), keyOf(canonicalPath(path.join(cwd, 'src', 'b.ts'))))
  assert.deepEqual(
    patchedFiles('*** Begin Patch\n*** Add File: x.ts\n+1\n*** Update File: y.ts\n*** Move to: z.ts\n*** Delete File: w.ts\n*** End Patch'),
    [
      { path: 'x.ts', op: 'add' },
      { path: 'y.ts', op: 'update' },
      { path: 'z.ts', op: 'move' },
      { path: 'w.ts', op: 'delete' },
    ],
  )
})

test('normalizeEvent: Devin has no cwd in the payload, so it comes from DEVIN_PROJECT_DIR', () => {
  const cwd = makeRepo('d')
  const ev = normalizeEvent('devin', payloadFor('devin', 'UserPromptSubmit', { prompt: 'hi' }, { cwd }), { DEVIN_PROJECT_DIR: cwd })
  assert.equal(keyOf(ev.cwd), keyOf(canonicalPath(cwd)))
  assert.equal(ev.sessionId, 'sample-session')
  assert.equal(ev.prompt, 'hi')
})

test('normalizeEvent maps Claude TodoWrite and Codex update_plan to one task list', () => {
  const todos = [
    { text: 'write tests', status: 'completed' },
    { text: 'fix bug', status: 'in_progress' },
  ]
  const c = normalizeEvent('claude', payloadFor('claude', 'PostToolUse', { tool: 'todo', todos }, { cwd: '/tmp' }), {})
  const x = normalizeEvent('codex', payloadFor('codex', 'PostToolUse', { tool: 'todo', todos }, { cwd: '/tmp' }), {})
  assert.deepEqual(c.todos.map((t) => [t.text, t.status]), [['write tests', 'completed'], ['fix bug', 'in_progress']])
  assert.deepEqual(x.todos.map((t) => [t.text, t.status]), [['write tests', 'completed'], ['fix bug', 'in_progress']])
})

test('renderOutput honours each agent contract', () => {
  const ctx = { context: 'ctx', notice: 'note' }
  // Codex: exact keys only.
  assert.deepEqual(JSON.parse(renderOutput('codex', 'SessionStart', ctx)), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' },
    systemMessage: 'note',
  })
  // Grok discards SessionStart output entirely.
  assert.equal(renderOutput('grok', 'SessionStart', ctx), '')
  assert.deepEqual(JSON.parse(renderOutput('grok', 'PostToolUse', ctx)), {
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'ctx' },
  })
  // Devin takes no additionalContext on PreToolUse.
  assert.deepEqual(JSON.parse(renderOutput('devin', 'PreToolUse', ctx)), { systemMessage: 'note' })
  // Stop with a block reason is a continuation request everywhere.
  for (const agent of ['claude', 'codex', 'grok', 'devin']) {
    assert.deepEqual(JSON.parse(renderOutput(agent, 'Stop', { block: 'fix it' })), { decision: 'block', reason: 'fix it' })
  }
  assert.equal(renderOutput('codex', 'SessionEnd', ctx), '')
  assert.equal(renderOutput('claude', 'Stop', {}), '')
})

test('fsx: atomic write, locked update, stale lock recovery', () => {
  const { root } = tempStore()
  const file = path.join(root, 'x', 'data.json')
  writeJsonAtomic(file, { n: 1 })
  assert.deepEqual(readJson(file), { n: 1 })
  for (let i = 0; i < 20; i++) updateJson(file, { n: 0 }, (cur) => ({ n: cur.n + 1 }))
  assert.equal(readJson(file).n, 21)
  fs.mkdirSync(`${file}.lock`)
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(`${file}.lock`, old, old)
  assert.equal(withLock(file, () => 'ran'), 'ran')
  assert.equal(readJson(path.join(root, 'missing.json'), 'fallback'), 'fallback')
})

test('parseArgs: flags, booleans, values, --', () => {
  const { flags, positionals } = parseArgs(['add', 'fix', 'it', '--json', '--cwd', 'd:/x', '--fix=use npm', '--', '--literal'])
  assert.deepEqual(positionals, ['add', 'fix', 'it', '--literal'])
  assert.deepEqual(flags, { json: true, cwd: 'd:/x', fix: 'use npm' })
})

const probe = {
  name: 'probe',
  hooks: {
    SessionStart: (ctx) => ctx.out.context.push(`hello ${ctx.ev.agent}`),
    PostToolUse: (ctx) => ctx.out.context.push(`edited ${ctx.ev.edits.length}`),
    Stop: (ctx) => {
      if (!ctx.ev.stopHookActive) ctx.out.block = 'keep going'
    },
  },
  tools: [
    {
      name: 'probe_echo',
      description: 'echo',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      run: (args, m) => ({ text: `${m.agent}:${args.text}`, data: { agent: m.agent } }),
    },
  ],
}

test('runtime: Grok SessionStart context waits for the next PostToolUse', async () => {
  const { env } = tempStore()
  const cwd = makeRepo('grokq')
  const start = await hook('grok', 'SessionStart', {}, { cwd, env, mods: [probe] })
  assert.equal(start.raw, '')
  const post = await hook('grok', 'PostToolUse', { tool: 'edit', file: path.join(cwd, 'src', 'x.ts') }, { cwd, env, mods: [probe] })
  assert.equal(contextOf(post), 'hello grok\n\nedited 1')
  const again = await hook('grok', 'PostToolUse', { tool: 'edit', file: path.join(cwd, 'src', 'x.ts') }, { cwd, env, mods: [probe] })
  assert.equal(contextOf(again), 'edited 1')
})

test('runtime: Claude, Codex and Devin get SessionStart context immediately', async () => {
  const { env } = tempStore()
  const cwd = makeRepo('now')
  for (const agent of ['claude', 'codex', 'devin']) {
    const reply = await hook(agent, 'SessionStart', {}, { cwd, env, mods: [probe] })
    assert.equal(contextOf(reply), `hello ${agent}`, agent)
  }
})

test('runtime: Stop block, stop_hook_active guard, malformed stdin, disable switch', async () => {
  const { env } = tempStore()
  const cwd = makeRepo('stop')
  assert.deepEqual((await hook('claude', 'Stop', {}, { cwd, env, mods: [probe] })).json, { decision: 'block', reason: 'keep going' })
  assert.equal((await hook('claude', 'Stop', { stopHookActive: true }, { cwd, env, mods: [probe] })).raw, '')
  // Grok's observe-only Stop at session close does nothing.
  assert.equal((await hook('grok', 'Stop', { reason: 'channel_closed' }, { cwd, env, mods: [probe] })).raw, '')
  const { runHook } = await import('../lib/core/runtime.mjs')
  assert.equal(await runHook({ stdinText: 'not json', env, mods: [probe] }), '')
  assert.equal(await runHook({ stdinText: '{}', env: { ...env, AGENT_MODS_DISABLE: '1' }, mods: [probe] }), '')
})

test('runtime: a throwing mod is logged and the others still run', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('boom')
  const boom = { name: 'boom', hooks: { SessionStart: () => { throw new Error('kaboom') } } }
  const reply = await hook('claude', 'SessionStart', {}, { cwd, env, mods: [boom, probe] })
  assert.equal(contextOf(reply), 'hello claude')
  assert.match(fs.readFileSync(store.path('logs', 'errors.log'), 'utf8'), /kaboom/)
})

test('mcp: initialize, tools/list, tools/call; agent from clientInfo', async () => {
  const { env } = tempStore()
  const client = mcpClient({ mods: [probe], env, clientName: 'codex-mcp-client' })
  const init = await client.init()
  assert.equal(init.result.serverInfo.name, 'agent-mods')
  assert.equal(init.result.protocolVersion, '2025-06-18')
  const list = await client.call('tools/list', {})
  assert.deepEqual(list.result.tools.map((t) => t.name), ['probe_echo'])
  const result = await client.tool('probe_echo', { text: 'hi' })
  assert.equal(result.content[0].text, 'codex:hi')
  assert.deepEqual(result.data, { agent: 'codex' })
  const missing = await client.tool('nope', {})
  assert.equal(missing.isError, true)
  const unknown = await client.call('bogus/method', {})
  assert.equal(unknown.error.code, -32601)
  client.close()
})

test('normalizeEvent: an empty or zero CLAUDE_PID is no pid', () => {
  const payload = payloadFor('claude', 'SessionStart', {}, { cwd: makeRepo('pid') })
  assert.equal(normalizeEvent('claude', payload, { CLAUDE_PID: '' }).pid, null)
  assert.equal(normalizeEvent('claude', payload, { CLAUDE_PID: '0' }).pid, null)
  assert.equal(normalizeEvent('claude', payload, { CLAUDE_PID: '4242' }).pid, 4242)
})

test('renderOutput: a Stop block keeps the notice for agents that show Stop notices', () => {
  for (const agent of ['claude', 'codex', 'devin']) {
    assert.deepEqual(JSON.parse(renderOutput(agent, 'Stop', { block: 'fix it', notice: 'shelved 1 idea' })), {
      decision: 'block',
      reason: 'fix it',
      systemMessage: 'shelved 1 idea',
    })
  }
  assert.deepEqual(JSON.parse(renderOutput('grok', 'Stop', { block: 'fix it', notice: 'shelved 1 idea' })), { decision: 'block', reason: 'fix it' })
})

test('fitContext: one long part is trimmed before a short part is lost', async () => {
  const short = '[agent-mods] another Codex session edited src/a.ts 2m ago'
  const fitted = fitContext(['B'.repeat(9000), short])
  assert.ok(fitted.length <= MAX_CONTEXT_CHARS, `length ${fitted.length}`)
  assert.ok(fitted.endsWith(short), 'the short part survives whole')
  assert.equal(fitContext(['a', 'b']), 'a\n\nb')
  const { env } = tempStore()
  const cwd = makeRepo('fit')
  const big = { name: 'big', hooks: { UserPromptSubmit: (ctx) => void ctx.out.context.push('B'.repeat(9000)) } }
  const rules = { name: 'rules', hooks: { UserPromptSubmit: (ctx) => void ctx.out.context.push('RULES: never touch prod') } }
  const text = contextOf(await hook('claude', 'UserPromptSubmit', { prompt: 'hi' }, { cwd, env, mods: [big, rules] }))
  assert.ok(text.includes('RULES: never touch prod'), 'a later mod keeps its context')
  assert.ok(text.length <= MAX_CONTEXT_CHARS)
})

test('listRecords: since skips records not written since then, without opening them', () => {
  const { store } = tempStore()
  const now = Date.now()
  for (const id of ['fresh', 'stale']) store.writeJson(`sessions/claude__${id}.json`, { agent: 'claude', id, beatAt: now })
  const old = new Date(now - 3 * 3_600_000)
  fs.utimesSync(store.path('sessions', 'claude__stale.json'), old, old)
  assert.deepEqual(listRecords(store, { since: now - 30 * 60_000 }).map((r) => r.id), ['fresh'])
  assert.deepEqual(listRecords(store).map((r) => r.id).sort(), ['fresh', 'stale'])
})

test('resolveCallerSession: an explicit id that matches no record resolves to nothing', () => {
  const { store } = tempStore()
  const project = projectInfo(makeRepo('caller'))
  const now = Date.now()
  store.writeJson('sessions/claude__live-1.json', { agent: 'claude', id: 'live-1', worktreeKey: project.worktreeKey, beatAt: now })
  assert.equal(resolveCallerSession(store, { agent: null, sessionId: 'someone-else', project, now }), null)
  assert.equal(resolveCallerSession(store, { agent: null, sessionId: 'live-1', project, now })?.key, 'claude__live-1')
  assert.equal(resolveCallerSession(store, { agent: null, project, now })?.key, 'claude__live-1', 'no id still finds the newest live session')
})

test('cli: a valueless --cwd or --project is refused; the caller agent comes from the session env', async () => {
  const { env } = tempStore()
  for (const flag of ['--cwd', '--project']) {
    let err = ''
    const code = await runCli({ argv: ['project-key', flag], env, stdout: { write() {} }, stderr: { write: (t) => (err += t) }, mods: [] })
    assert.equal(code, 2)
    assert.match(err, new RegExp(`${flag} takes a directory`))
  }
  const agentOf = (extra, argv = []) => makeCliContext({ argv, env: { ...env, ...extra }, stdout: { write() {} } }).agent
  assert.equal(agentOf({ CODEX_THREAD_ID: 't1', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'c1' }), 'codex', 'innermost agent wins')
  assert.equal(agentOf({ CLAUDE_CODE_SESSION_ID: 'c1' }), 'claude')
  assert.equal(agentOf({ GROK_SESSION_ID: 'g1' }), 'grok')
  assert.equal(agentOf({ AGENT_MODS_AGENT: 'devin' }), 'devin')
  assert.equal(agentOf({ CLAUDECODE: '1' }, ['--agent', 'grok']), 'grok')
  assert.equal(agentOf({}), null)
})

test('mcp: tool results are text only, because Codex shows structuredContent in place of the text', async () => {
  const { env } = tempStore()
  const probe = { name: 'probe', tools: [{ name: 'probe_tool', description: 'returns text and data', inputSchema: { type: 'object', properties: {} }, run: () => ({ text: 'two messages: hi, bye', data: { messages: 2 } }) }] }
  const client = mcpClient({ mods: [probe], env, clientName: 'codex-mcp-client' })
  try {
    await client.init()
    const raw = (await client.call('tools/call', { name: 'probe_tool', arguments: {} })).result
    assert.equal(raw.structuredContent, undefined, 'Codex would drop the text and show only {"messages":2}')
    assert.deepEqual(raw.content, [{ type: 'text', text: 'two messages: hi, bye' }])
    assert.deepEqual(raw._meta, { 'agent-mods/data': { messages: 2 } })
  } finally {
    client.close()
  }
})
