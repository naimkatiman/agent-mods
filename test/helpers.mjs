// Shared test harness: temp stores, fake repos/worktrees, and hook payloads shaped exactly like each
// agent sends them (shapes from the 2026-10-11 survey of this host's Claude 2.1.296, Codex 0.162.1,
// Grok 1.0.51 and Devin 1.126.0). Never touches the real ~/.agent-mods or any agent home.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runHook } from '../lib/core/runtime.mjs'
import { openStore } from '../lib/core/store.mjs'
import { createMcpServer } from '../lib/core/mcp.mjs'
import { PassThrough } from 'node:stream'

export function tempDir(prefix = 'am-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function tempStore() {
  const root = tempDir('am-store-')
  return { root, env: { AGENT_MODS_HOME: root }, store: openStore(root) }
}

// A main checkout: <tmp>/<name>/.git/
export function makeRepo(name = 'shop') {
  const dir = path.join(tempDir('am-repo-'), name)
  fs.mkdirSync(path.join(dir, '.git', 'worktrees'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  return dir
}

// A linked worktree of mainRepo, laid out the way `git worktree add` does it.
export function makeWorktree(mainRepo, name = 'wt') {
  const wt = path.join(tempDir('am-wt-'), name)
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
  const gitdir = path.join(mainRepo, '.git', 'worktrees', name)
  fs.mkdirSync(gitdir, { recursive: true })
  fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n')
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir.replace(/\\/g, '/')}\n`)
  return wt
}

const SNAKE = {
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt_submit',
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  Stop: 'stop',
  Notification: 'notification',
}

export const SESSION_IDS = {
  claude: '11111111-1111-4111-8111-111111111111',
  codex: '22222222-2222-4222-8222-222222222222',
  grok: '33333333-3333-4333-8333-333333333333',
  devin: 'sample-session',
}

// Generic fields in, agent-specific payload out. Generic field names:
// prompt, tool (generic 'edit' | 'write' | 'todo' | 'ask' | a raw tool name), file, todos,
// answer, stopHookActive, source, reason, notificationType, message, isSubagent.
export function payloadFor(agent, event, fields = {}, { cwd, sessionId, home } = {}) {
  const id = sessionId ?? SESSION_IDS[agent]
  const toolName = toolNameFor(agent, fields.tool)
  const toolInput = toolInputFor(agent, fields, cwd)
  if (agent === 'grok') {
    const p = {
      hookEventName: SNAKE[event] ?? event,
      hook_event_name: event,
      sessionId: id,
      cwd,
      workspaceRoot: cwd,
      timestamp: new Date().toISOString(),
      permissionMode: 'default',
    }
    if (event !== 'SessionStart' && event !== 'SessionEnd') p.promptId = 'prompt-1'
    if (fields.prompt !== undefined) p.prompt = fields.prompt
    if (toolName) Object.assign(p, { toolName, toolInput, toolUseId: 'tu-1', toolInputTruncated: false })
    if (event === 'PostToolUse') Object.assign(p, { toolResult: { ok: true }, tool_response: { ok: true } })
    if (event === 'Stop') Object.assign(p, { stopHookActive: Boolean(fields.stopHookActive), lastAssistantMessage: fields.answer ?? '', reason: fields.reason ?? 'end_turn' })
    if (event === 'SessionEnd' && fields.reason) p.reason = fields.reason
    if (fields.isSubagent) p.subagentType = 'general'
    if (event === 'Notification') Object.assign(p, { notificationType: fields.notificationType ?? 'idle_prompt', message: fields.message ?? '' })
    return p
  }
  const p = { hook_event_name: event, session_id: id }
  if (agent === 'claude') Object.assign(p, { transcript_path: `${home ?? 'C:/Users/test/.claude'}/projects/x/${id}.jsonl`, cwd, permission_mode: 'default' })
  if (agent === 'codex') {
    Object.assign(p, {
      transcript_path: `${home ?? 'C:/Users/test/.codex'}/sessions/2026/10/11/rollout-2026-10-11T18-09-41-${id}.jsonl`,
      cwd,
      model: 'gpt-5.5',
    })
    if (event !== 'SessionEnd') Object.assign(p, { turn_id: 'turn-1', permission_mode: 'bypassPermissions' })
  }
  if (agent === 'devin' && event !== 'SessionStart') p.prompt_id = 'prompt-1'
  if (fields.prompt !== undefined) p.prompt = fields.prompt
  if (toolName) Object.assign(p, { tool_name: toolName, tool_input: toolInput, tool_use_id: 'tu-1' })
  if (event === 'PostToolUse') p.tool_response = agent === 'devin' ? { success: true, output: 'ok', error: null } : { ok: true }
  if (event === 'Stop') Object.assign(p, { stop_hook_active: Boolean(fields.stopHookActive), last_assistant_message: fields.answer ?? '' })
  if (event === 'SessionStart') p.source = fields.source ?? 'startup'
  if (event === 'SessionEnd') p.reason = fields.reason ?? 'other'
  if (event === 'Notification') Object.assign(p, { notification_type: fields.notificationType ?? 'permission_prompt', message: fields.message ?? '' })
  if (fields.isSubagent) Object.assign(p, { agent_id: 'sub-1', agent_type: 'general-purpose' })
  return p
}

function toolNameFor(agent, tool) {
  if (!tool) return null
  const map = {
    edit: { claude: 'Edit', codex: 'apply_patch', grok: 'search_replace', devin: 'edit' },
    write: { claude: 'Write', codex: 'apply_patch', grok: 'write', devin: 'write' },
    todo: { claude: 'TodoWrite', codex: 'update_plan', grok: 'todo_write', devin: 'todo_write' },
    ask: { claude: 'AskUserQuestion', codex: 'request_user_input', grok: 'ask_user_question', devin: 'ask_user_question' },
    shell: { claude: 'Bash', codex: 'Bash', grok: 'run_terminal_command', devin: 'exec' },
  }
  return map[tool]?.[agent] ?? tool
}

function toolInputFor(agent, fields, cwd) {
  if (fields.toolInput) return fields.toolInput
  if (fields.tool === 'edit' || fields.tool === 'write') {
    const file = fields.file
    if (agent === 'codex') {
      const rel = path.isAbsolute(file) ? path.relative(cwd, file).replace(/\\/g, '/') : file
      return { command: `*** Begin Patch\n*** ${fields.tool === 'write' ? 'Add' : 'Update'} File: ${rel}\n@@\n-a\n+b\n*** End Patch\n` }
    }
    return { file_path: file, old_string: 'a', new_string: 'b' }
  }
  if (fields.tool === 'todo') {
    const todos = fields.todos ?? []
    if (agent === 'codex') return { plan: todos.map((t) => ({ step: t.text, status: t.status })) }
    return { todos: todos.map((t) => ({ content: t.text, status: t.status, activeForm: t.text })) }
  }
  if (fields.tool === 'shell') return { command: fields.command ?? 'echo hi' }
  return null
}

// Env each agent's hook process sees.
export function envFor(agent, { cwd, base = {}, homes = {} } = {}) {
  const env = { ...base }
  if (agent === 'grok') Object.assign(env, { GROK_HOOK_EVENT: 'x', GROK_HOME: homes.grok ?? path.join(base.AGENT_MODS_HOME ?? os.tmpdir(), 'fake-grok'), CLAUDE_PROJECT_DIR: cwd })
  if (agent === 'devin') Object.assign(env, { DEVIN_PROJECT_DIR: cwd, CLAUDE_PROJECT_DIR: cwd, APPDATA: homes.appdata ?? path.join(base.AGENT_MODS_HOME ?? os.tmpdir(), 'fake-appdata') })
  if (agent === 'claude') Object.assign(env, { CLAUDE_PROJECT_DIR: cwd, CLAUDE_CONFIG_DIR: homes.claude ?? path.join(base.AGENT_MODS_HOME ?? os.tmpdir(), 'fake-claude') })
  return env
}

// Run one hook as `agent` would. Returns { raw, json } where json is the parsed reply or null.
export async function hook(agent, event, fields = {}, opts = {}) {
  const { cwd, env = {}, now, mods, sessionId } = opts
  const payload = payloadFor(agent, event, fields, { cwd, sessionId, home: opts.home })
  const raw = await runHook({
    argv: agent === 'codex' ? ['--agent', 'codex'] : [],
    env: envFor(agent, { cwd, base: env }),
    stdinText: JSON.stringify(payload),
    now: now ?? Date.now(),
    mods,
  })
  return { raw, json: raw ? JSON.parse(raw) : null }
}

export function contextOf(reply) {
  return reply?.json?.hookSpecificOutput?.additionalContext ?? ''
}

// In-process MCP client over PassThrough streams.
export function mcpClient({ mods, env, clientName = 'claude-code' }) {
  const input = new PassThrough()
  const output = new PassThrough()
  const server = createMcpServer({ mods, env, input, output })
  let buffer = ''
  const waiters = new Map()
  output.setEncoding('utf8')
  output.on('data', (chunk) => {
    buffer += chunk
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      waiters.get(msg.id)?.(msg)
      waiters.delete(msg.id)
    }
  })
  let id = 0
  const call = (method, params) =>
    new Promise((resolve) => {
      const myId = ++id
      waiters.set(myId, resolve)
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`)
    })
  return {
    server,
    call,
    async init() {
      return call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: clientName, version: '1' }, capabilities: {} })
    },
    // `data` is what the tool returned beside its text; it travels in _meta, never structuredContent.
    async tool(name, args = {}) {
      const reply = await call('tools/call', { name, arguments: args })
      return { ...reply.result, data: reply.result?._meta?.['agent-mods/data'] }
    },
    close() {
      server.close()
      input.end()
    },
  }
}
