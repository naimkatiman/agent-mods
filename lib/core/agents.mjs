// Agent detection, payload normalization and per-agent output shapes.
//
// One hook command (node D:/Ai/agent-mods/bin/agent-mods-hook.mjs) is registered in ~/.claude/settings.json and
// therefore runs in Claude Code, Grok (both homes, via its Claude compat import) and Devin Local
// (its Claude importer). Codex has its own registration that passes --agent codex. Each agent sends
// a different payload and accepts a different reply; this file is the only place that knows.
import os from 'node:os'
import path from 'node:path'
import { canonicalPath } from './project.mjs'
import { cut, wellFormed } from './text.mjs'

export const AGENTS = ['claude', 'codex', 'grok', 'devin', 'cascade']

const SNAKE_EVENTS = {
  session_start: 'SessionStart',
  session_end: 'SessionEnd',
  user_prompt_submit: 'UserPromptSubmit',
  pre_tool_use: 'PreToolUse',
  post_tool_use: 'PostToolUse',
  post_tool_use_failure: 'PostToolUseFailure',
  stop: 'Stop',
  stop_failure: 'StopFailure',
  stop_cancelled: 'StopCancelled',
  subagent_start: 'SubagentStart',
  subagent_stop: 'SubagentStop',
  subagent_end: 'SubagentStop',
  notification: 'Notification',
  pre_compact: 'PreCompact',
  post_compact: 'PostCompact',
  permission_request: 'PermissionRequest',
  permission_denied: 'PermissionDenied',
}

// Windsurf/Cascade format (agent_action_name) mapped onto the generic events.
const CASCADE_EVENTS = {
  pre_user_prompt: 'UserPromptSubmit',
  post_write_code: 'PostToolUse',
  post_run_command: 'PostToolUse',
  post_cascade_response: 'Stop',
  post_cascade_response_with_transcript: 'Stop',
}

export function canonicalEvent(name) {
  if (!name) return null
  const value = String(name)
  if (SNAKE_EVENTS[value]) return SNAKE_EVENTS[value]
  if (/^[A-Z]/.test(value)) return value
  const camel = value.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase())
  return camel
}

export function agentFromName(name) {
  const value = String(name ?? '').toLowerCase()
  if (value.includes('claude')) return 'claude'
  if (value.includes('codex') || value.includes('openai')) return 'codex'
  if (value.includes('grok') || value.includes('xai')) return 'grok'
  if (value.includes('cascade') || value.includes('windsurf')) return 'cascade'
  if (value.includes('devin') || value.includes('cognition')) return 'devin'
  return null
}

export function detectAgent({ argv = [], env = {}, payload = {} } = {}) {
  const flag = argv.indexOf('--agent')
  if (flag >= 0 && argv[flag + 1]) return agentFromName(argv[flag + 1]) ?? String(argv[flag + 1]).toLowerCase()
  if (env.GROK_HOOK_EVENT || (payload.hookEventName && payload.sessionId)) return 'grok'
  if (env.DEVIN_PROJECT_DIR) return 'devin'
  if (payload.agent_action_name) return 'cascade'
  if (payload.turn_id && /rollout-/.test(String(payload.transcript_path ?? ''))) return 'codex'
  return 'claude'
}

function first(obj, ...keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key]
  }
  return undefined
}

function homeFor(agent, payload, env) {
  if (agent === 'claude') return canonicalPath(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'))
  if (agent === 'grok') return canonicalPath(env.GROK_HOME || path.join(os.homedir(), '.grok'))
  if (agent === 'codex') {
    const transcript = String(payload.transcript_path ?? '').replace(/\\/g, '/')
    const at = transcript.toLowerCase().lastIndexOf('/sessions/')
    if (at > 0) return canonicalPath(transcript.slice(0, at))
    const archived = transcript.toLowerCase().lastIndexOf('/archived_sessions/')
    if (archived > 0) return canonicalPath(transcript.slice(0, archived))
    return canonicalPath(env.CODEX_HOME || path.join(os.homedir(), '.codex'))
  }
  if (agent === 'devin') return canonicalPath(path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'devin'))
  return null
}

const EDIT_TOOL_NAMES = new Set([
  'edit', 'write', 'multiedit', 'notebookedit', 'notebook_edit', 'apply_patch', 'search_replace',
  'str_replace', 'create_file', 'write_file', 'edit_file',
])
const TODO_TOOL_NAMES = new Set(['todowrite', 'todo_write', 'update_plan'])
const ASK_TOOL_NAMES = new Set(['askuserquestion', 'ask_user_question', 'request_user_input'])
const PATH_KEYS = ['file_path', 'notebook_path', 'filePath', 'path', 'target_file', 'targetFile', 'file']

export function toolKind(toolName) {
  const name = String(toolName ?? '').toLowerCase()
  if (!name) return null
  if (EDIT_TOOL_NAMES.has(name)) return 'edit'
  if (TODO_TOOL_NAMES.has(name)) return 'todo'
  if (ASK_TOOL_NAMES.has(name)) return 'ask'
  if (['bash', 'powershell', 'run_terminal_command', 'exec', 'shell'].includes(name)) return 'shell'
  if (['read', 'read_file', 'notebook_read', 'view'].includes(name)) return 'read'
  if (['grep', 'glob', 'list_dir', 'find_file_by_name', 'search'].includes(name)) return 'search'
  if (['websearch', 'webfetch', 'web_search', 'web_fetch'].includes(name)) return 'web'
  if (['task', 'agent', 'spawn_agent', 'spawn_subagent', 'run_subagent'].includes(name)) return 'agent'
  if (name.startsWith('mcp__') || name.includes('__')) return 'mcp'
  return 'other'
}

// Codex apply_patch (and Devin's) carries the whole patch as text. Line by line, because a regex with
// (.+?)\s*$ over the whole patch backtracks quadratically on a header padded with spaces (65k spaces
// took 11.7 s, past the hook's watchdog, which cannot fire during a synchronous match).
const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: (.+)$/
const PATCH_MOVE = /^\*\*\* Move to: (.+)$/

export function patchedFiles(text) {
  const out = []
  for (const raw of String(text).split('\n')) {
    if (raw.length > 4096 || !raw.startsWith('*** ')) continue
    const line = raw.trimEnd()
    const file = PATCH_FILE.exec(line)
    if (file) {
      out.push({ path: file[2], op: file[1].toLowerCase() })
      continue
    }
    const move = PATCH_MOVE.exec(line)
    if (move) out.push({ path: move[1], op: 'move' })
  }
  return out
}

function stringsIn(value, depth = 0) {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object' || depth > 2) return []
  return Object.values(value).flatMap((v) => stringsIn(v, depth + 1))
}

export function editedFiles(toolName, toolInput, cwd) {
  if (toolKind(toolName) !== 'edit') return []
  const found = []
  if (toolInput && typeof toolInput === 'object') {
    for (const key of PATH_KEYS) {
      if (typeof toolInput[key] === 'string' && toolInput[key].trim()) {
        found.push({ path: toolInput[key], op: String(toolName).toLowerCase() === 'write' ? 'write' : 'edit' })
        break
      }
    }
  }
  if (!found.length) {
    for (const text of stringsIn(toolInput)) {
      if (text.includes('*** ') && /\*\*\* (Add|Update|Delete) File: /.test(text)) {
        found.push(...patchedFiles(text))
      }
    }
  }
  const seen = new Set()
  const out = []
  for (const item of found) {
    const abs = canonicalPath(item.path, cwd || undefined)
    if (!abs || seen.has(abs.toLowerCase())) continue
    seen.add(abs.toLowerCase())
    out.push({ path: abs, op: item.op })
  }
  return out
}

function normStatus(status) {
  const value = String(status ?? '').toLowerCase().replace(/[\s-]+/g, '_')
  if (['completed', 'complete', 'done'].includes(value)) return 'completed'
  if (['in_progress', 'active', 'doing', 'running'].includes(value)) return 'in_progress'
  return 'pending'
}

export function todoList(toolName, toolInput) {
  if (toolKind(toolName) !== 'todo' || !toolInput || typeof toolInput !== 'object') return null
  const list = toolInput.todos ?? toolInput.plan ?? toolInput.items ?? toolInput.tasks
  if (!Array.isArray(list)) return null
  return list
    .map((item, i) => {
      if (typeof item === 'string') return { id: `todo-${i}`, text: item, status: 'pending' }
      const text = item?.content ?? item?.text ?? item?.step ?? item?.title ?? item?.subject ?? ''
      return { id: String(item?.id ?? `todo-${i}`), text: String(text), status: normStatus(item?.status) }
    })
    .filter((t) => t.text.trim())
}

function toolFailed(agent, response) {
  if (!response || typeof response !== 'object') return false
  if (response.success === false || response.isError === true || response.is_error === true) return true
  if (agent === 'devin' && response.error) return true
  return false
}

export function normalizeEvent(agent, payload = {}, env = {}) {
  const p = payload ?? {}
  if (agent === 'cascade') {
    const info = p.tool_info ?? {}
    const event = CASCADE_EVENTS[p.agent_action_name] ?? null
    const toolInput = info.file_path ? { file_path: info.file_path } : null
    return finish({
      agent,
      home: null,
      event,
      sessionId: p.trajectory_id ? String(p.trajectory_id) : null,
      cwd: info.cwd ?? env.ROOT_WORKSPACE_PATH ?? process.cwd(),
      prompt: info.user_prompt ?? null,
      toolName: p.agent_action_name === 'post_write_code' ? 'write' : null,
      toolInput,
      lastAssistantMessage: info.response ?? null,
      turnId: p.execution_id ?? null,
      raw: p,
    })
  }
  const toolInput = first(p, 'tool_input', 'toolInput') ?? null
  let cwd = first(p, 'cwd', 'workspaceRoot', 'workspace_root')
  if (!cwd) cwd = env.DEVIN_PROJECT_DIR || env.CLAUDE_PROJECT_DIR || env.GROK_WORKSPACE_ROOT || process.cwd()
  const attendedRaw = env.CLAUDE_CODE_SESSION_ATTENDED
  return finish({
    agent,
    home: homeFor(agent, p, env),
    event: canonicalEvent(first(p, 'hook_event_name', 'hookEventName')),
    sessionId: (() => {
      const id = first(p, 'session_id', 'sessionId')
      return id === undefined ? null : String(id)
    })(),
    cwd,
    prompt: first(p, 'prompt', 'user_prompt'),
    toolName: first(p, 'tool_name', 'toolName') ?? null,
    toolInput,
    toolResponse: first(p, 'tool_response', 'toolResult', 'toolResponse') ?? null,
    lastAssistantMessage: first(p, 'last_assistant_message', 'lastAssistantMessage') ?? null,
    stopHookActive: Boolean(first(p, 'stop_hook_active', 'stopHookActive')),
    isSubagent: Boolean(first(p, 'agent_id', 'subagentId', 'subagentType', 'subagent_type')),
    source: first(p, 'source') ?? null,
    reason: first(p, 'reason') ?? null,
    notificationType: first(p, 'notification_type', 'notificationType') ?? null,
    message: first(p, 'message') ?? null,
    sessionTitle: first(p, 'session_title', 'sessionTitle') ?? null,
    transcriptPath: first(p, 'transcript_path', 'transcriptPath') ?? null,
    turnId: first(p, 'turn_id', 'prompt_id', 'promptId', 'turnId') ?? null,
    attended: attendedRaw === '1' ? true : attendedRaw === '0' ? false : null,
    entrypoint: env.CLAUDE_CODE_ENTRYPOINT ?? null,
    pid: agent === 'claude' ? claudePid(env.CLAUDE_PID) : null,
    raw: p,
  })
}

// Number('') is 0, and an empty CLAUDE_PID must not read as pid 0.
function claudePid(raw) {
  const pid = Number(raw)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

function finish(ev) {
  const cwd = canonicalPath(ev.cwd) ?? canonicalPath(process.cwd())
  const toolName = ev.toolName ?? null
  return {
    agent: ev.agent,
    home: ev.home ?? null,
    event: ev.event ?? null,
    sessionId: ev.sessionId ?? null,
    cwd,
    prompt: typeof ev.prompt === 'string' ? ev.prompt : null,
    toolName,
    toolKind: toolKind(toolName),
    toolInput: ev.toolInput ?? null,
    toolResponse: ev.toolResponse ?? null,
    toolFailed: toolFailed(ev.agent, ev.toolResponse),
    edits: editedFiles(toolName, ev.toolInput, cwd),
    todos: todoList(toolName, ev.toolInput),
    lastAssistantMessage: typeof ev.lastAssistantMessage === 'string' ? ev.lastAssistantMessage : null,
    stopHookActive: Boolean(ev.stopHookActive),
    isSubagent: Boolean(ev.isSubagent),
    source: ev.source ?? null,
    reason: ev.reason ?? null,
    notificationType: ev.notificationType ?? null,
    message: typeof ev.message === 'string' ? ev.message : null,
    sessionTitle: typeof ev.sessionTitle === 'string' ? ev.sessionTitle : null,
    transcriptPath: ev.transcriptPath ?? null,
    turnId: ev.turnId === undefined || ev.turnId === null ? null : String(ev.turnId),
    attended: ev.attended ?? null,
    entrypoint: ev.entrypoint ?? null,
    pid: ev.pid ?? null,
    raw: ev.raw ?? {},
  }
}

// Which events let a hook put text in front of the model, per agent (verified 2026-10-11):
// Grok discards SessionStart/UserPromptSubmit stdout; Devin Local takes additionalContext only on
// SessionStart, UserPromptSubmit and PostToolUse; Codex rejects unknown keys and only takes
// additionalContext on the four events listed.
const CONTEXT_EVENTS = {
  claude: new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification']),
  codex: new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']),
  grok: new Set(['PreToolUse', 'PostToolUse']),
  devin: new Set(['SessionStart', 'UserPromptSubmit', 'PostToolUse']),
  cascade: new Set(),
}

// Which events show a systemMessage to the user.
const NOTICE_EVENTS = {
  claude: new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification']),
  codex: new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']),
  grok: new Set(),
  devin: new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']),
  cascade: new Set(),
}

const BLOCK_EVENTS = new Set(['Stop'])

export function canInjectContext(agent, event) {
  return CONTEXT_EVENTS[agent]?.has(event) ?? false
}

export function canShowNotice(agent, event) {
  return NOTICE_EVENTS[agent]?.has(event) ?? false
}

export const MAX_CONTEXT_CHARS = 7000

// Joins context parts within MAX_CONTEXT_CHARS. When they do not fit, the longest parts are cut to a
// fair share first, so one long briefing cannot push a short clash note or rules block out.
export function fitContext(parts, max = MAX_CONTEXT_CHARS) {
  const SEP = '\n\n'
  const items = parts.filter(Boolean).map(String)
  const seps = SEP.length * Math.max(0, items.length - 1)
  if (items.reduce((n, t) => n + t.length, seps) <= max) return items.join(SEP)
  let budget = Math.max(0, max - seps)
  let left = items.length
  const caps = []
  for (const i of items.map((_, i) => i).sort((a, b) => items[a].length - items[b].length)) {
    caps[i] = Math.min(items[i].length, Math.floor(budget / left))
    budget -= caps[i]
    left--
  }
  return items.map((t, i) => (t.length > caps[i] ? `${cut(t, Math.max(0, caps[i] - 1))}…` : t)).join(SEP)
}

// The agent whose shell ran a CLI command, from the session variables each agent gives its commands.
// Codex first: Codex started from inside Claude Code also inherits Claude's variables.
export function agentFromEnv(env = {}) {
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) return 'codex'
  if (env.GROK_SESSION_ID) return 'grok'
  if (env.CLAUDE_CODE_SESSION_ID || env.CLAUDECODE) return 'claude'
  return null
}

// Returns the exact stdout for this agent and event ('' = print nothing).
export function renderOutput(agent, event, { context = '', notice = '', block = null } = {}) {
  if (!event || agent === 'cascade' || event === 'SessionEnd') return ''
  const out = {}
  if (BLOCK_EVENTS.has(event) && block) {
    out.decision = 'block'
    out.reason = block
    if (notice && canShowNotice(agent, event)) out.systemMessage = notice
    return JSON.stringify(out, wellFormed)
  }
  if (context && canInjectContext(agent, event)) {
    const text = context.length > MAX_CONTEXT_CHARS ? `${cut(context, MAX_CONTEXT_CHARS - 1)}…` : context
    out.hookSpecificOutput = { hookEventName: event, additionalContext: text }
  }
  if (notice && canShowNotice(agent, event)) out.systemMessage = notice
  return Object.keys(out).length ? JSON.stringify(out, wellFormed) : ''
}
