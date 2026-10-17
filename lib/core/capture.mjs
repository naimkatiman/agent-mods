// Debug aid (config debug.capturePayloads): keep the latest payload SHAPE per agent and event, so a
// real session of each agent proves which keys and tool names it sends. Only structural values
// (event and tool names, ids, paths, statuses) are kept; every other string becomes its length, so
// prompt, todo, plan and patch text never land on disk.
import { safeName } from './fsx.mjs'
import { cut } from './text.mjs'

const DROP = new Set(['prompt', 'user_prompt', 'last_assistant_message', 'lastAssistantMessage', 'content', 'old_string', 'new_string', 'command', 'tool_response', 'toolResult', 'toolResponse'])
const KEEP_VALUE = new Set([
  'hook_event_name', 'hookEventName', 'tool_name', 'toolName', 'session_id', 'sessionId', 'cwd', 'workspaceRoot',
  'file_path', 'filePath', 'path', 'transcript_path', 'transcriptPath', 'permission_mode', 'permissionMode', 'source',
  'reason', 'notification_type', 'notificationType', 'status', 'type', 'model', 'agent_type', 'subagentType', 'turn_id',
])

function shape(value, depth = 0, key = '') {
  if (DROP.has(key)) return typeof value === 'string' ? `<string len=${value.length}>` : `<${Array.isArray(value) ? 'array' : typeof value}>`
  if (value === null || typeof value !== 'object') {
    if (typeof value !== 'string') return value
    if (!KEEP_VALUE.has(key)) return `<string len=${value.length}>`
    return value.length > 120 ? `${cut(value, 120)}…(${value.length})` : value
  }
  if (depth > 3) return Array.isArray(value) ? `<array len=${value.length}>` : '<object>'
  if (Array.isArray(value)) return value.slice(0, 3).map((v) => shape(v, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = shape(v, depth + 1, k)
  return out
}

const ENV_SIGNALS = ['GROK_HOOK_EVENT', 'GROK_HOME', 'GROK_SESSION_ID', 'DEVIN_PROJECT_DIR', 'CLAUDE_PROJECT_DIR', 'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CODEX_THREAD_ID', 'AI_AGENT', 'APPDATA']

export function capturePayload(store, ev, env) {
  try {
    const signals = {}
    for (const name of ENV_SIGNALS) if (env[name] !== undefined) signals[name] = name === 'CLAUDE_CODE_SESSION_ID' || name === 'GROK_SESSION_ID' || name === 'CODEX_THREAD_ID' ? '<set>' : shape(env[name])
    store.writeJson(`logs/payloads/${safeName(ev.agent)}-${safeName(ev.event)}${ev.toolName ? `-${safeName(ev.toolName)}` : ''}.json`, {
      at: new Date().toISOString(),
      agent: ev.agent,
      event: ev.event,
      toolName: ev.toolName,
      toolKind: ev.toolKind,
      edits: ev.edits.length,
      cwd: ev.cwd,
      home: ev.home,
      env: signals,
      payload: shape(ev.raw),
    })
  } catch {}
}
