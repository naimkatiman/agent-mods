// Pure config transforms for the installer: given a parsed config, return the next one. No fs, no
// processes, so every merge is unit-tested. Ours are recognized by the hook script name (MARKER) or
// the server name, never by position. A reinstall replaces ours where they stand, so no other hook
// moves (a Codex trust key is the hook's position); uninstall removes only ours.
import { MARKER, SERVER_NAME, hookCommand, MCP_COMMAND } from './hosts.mjs'

// Claude Code settings.json. The default home's file is also imported by Grok (both homes) and Devin
// Local, and Devin Local rejects the WHOLE file over one event key it does not know, which drops
// every hook in it, the user's own included (probed 2026-10-12 through `devin acp` session/new:
// "unknown variant `Notification`, expected one of `PreToolUse`, `PostToolUse`, `UserPromptSubmit`,
// `Stop`, `PostCompaction`, `SessionStart`, `SessionEnd`, `PermissionRequest`"). So the default home
// gets only events all three know; Claude-only events go to the alternate homes, read by Claude alone.
// PostToolUse names both vocabularies: Claude (Edit...), Grok (search_replace, write, todo_write;
// Grok also maps the Claude names) and Devin (edit, write, apply_patch, notebook_edit, todo_write).
export const DEVIN_CLAUDE_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PostCompaction', 'SessionStart', 'SessionEnd', 'PermissionRequest'])

export const SHARED_CLAUDE_EVENTS = [
  { event: 'SessionStart', matcher: '', timeout: 10 },
  { event: 'UserPromptSubmit', matcher: '', timeout: 10 },
  {
    event: 'PostToolUse',
    matcher: 'Edit|Write|MultiEdit|NotebookEdit|TodoWrite|search_replace|write|todo_write|edit|apply_patch|notebook_edit',
    timeout: 10,
  },
  { event: 'Stop', matcher: '', timeout: 10 },
  { event: 'SessionEnd', matcher: '', timeout: 5 },
]

// Permission waits and turns that end in an error; Claude Code only.
const CLAUDE_ONLY_EVENTS = [
  { event: 'Notification', matcher: '', timeout: 10 },
  { event: 'StopFailure', matcher: '', timeout: 5 },
]

export function claudeEventsFor(home) {
  return home?.isDefault ? SHARED_CLAUDE_EVENTS : [...SHARED_CLAUDE_EVENTS, ...CLAUDE_ONLY_EVENTS]
}

// Codex hooks.json (deny_unknown_fields: top level is only description + hooks). apply_patch also
// answers to the Edit/Write aliases; update_plan is Codex's task list. SessionEnd is capped at 3 s.
// Interrupt runs when the user aborts a turn (HookEventName in codex 0.162.1's own schema).
export const CODEX_EVENTS = [
  { event: 'SessionStart', timeout: 10 },
  { event: 'UserPromptSubmit', timeout: 10 },
  { event: 'PostToolUse', matcher: '^(apply_patch|update_plan)$', timeout: 10 },
  { event: 'Stop', timeout: 10 },
  { event: 'Interrupt', timeout: 3 },
  { event: 'SessionEnd', timeout: 3 },
]

function isOurs(handler) {
  return typeof handler?.command === 'string' && handler.command.replace(/\\/g, '/').includes(MARKER)
}

// What install added to one config file, recorded so uninstall can give back the exact original:
// { file: created the file, hooksKey: created the "hooks" object, events: event keys it created }.
export function createdBy(current, specs) {
  const hooks = current?.hooks
  return {
    file: current === null || current === undefined,
    hooksKey: !hooks || typeof hooks !== 'object',
    events: specs.map((s) => s.event).filter((event) => !Array.isArray(hooks?.[event])),
  }
}

// Removes our handlers; a group left with none goes too. An event list left empty is dropped only
// when install created that key (or nothing was recorded); a user's own "PostToolUse": [] stays.
export function withoutOurHooks(hooks, created = null) {
  if (!hooks || typeof hooks !== 'object') return {}
  const out = {}
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      out[event] = groups
      continue
    }
    const kept = []
    for (const group of groups) {
      const handlers = Array.isArray(group?.hooks) ? group.hooks : null
      if (!handlers) {
        kept.push(group)
        continue
      }
      const remaining = handlers.filter((h) => !isOurs(h))
      if (remaining.length === handlers.length) kept.push(group)
      else if (remaining.length) kept.push({ ...group, hooks: remaining })
    }
    if (kept.length || !groups.length || (created && !created.events?.includes(event))) out[event] = kept
  }
  return out
}

// Puts our handler for each event where it already stands (replacing an outdated command), or
// appends a new group when there is none. Key order and every other group's index are kept. Ours on
// an event no longer in `specs` (an older install) are removed.
function placeOurs(hooks, specs, groupFor) {
  const wanted = new Set(specs.map((s) => s.event))
  const out = {}
  for (const [event, groups] of Object.entries(hooks && typeof hooks === 'object' ? hooks : {})) {
    if (wanted.has(event) || !Array.isArray(groups) || !groups.some((g) => g?.hooks?.some?.(isOurs))) {
      out[event] = groups
      continue
    }
    const rest = withoutOurHooks({ [event]: groups })[event]
    if (rest) out[event] = rest
  }
  for (const spec of specs) {
    const want = groupFor(spec)
    const next = []
    let placed = false
    for (const group of Array.isArray(out[spec.event]) ? out[spec.event] : []) {
      const handlers = Array.isArray(group?.hooks) ? group.hooks : null
      if (!handlers?.some(isOurs)) {
        next.push(group)
        continue
      }
      if (placed) {
        // A second copy of ours (an older install): drop it, keep anything else in that group.
        const rest = handlers.filter((h) => !isOurs(h))
        if (rest.length) next.push({ ...group, hooks: rest })
        continue
      }
      placed = true
      next.push(handlers.length === 1 ? want : { ...group, hooks: handlers.map((h) => (isOurs(h) ? want.hooks[0] : h)) })
    }
    if (!placed) next.push(want)
    out[spec.event] = next
  }
  return out
}

// Codex trust keys (<event_snake>:<group>) of other hooks that sit after ours and move up one place
// when ours are removed. Codex then treats them as changed until they are trusted again.
export function hooksAfterOurs(hooks) {
  const moved = []
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    if (!Array.isArray(groups)) continue
    const first = groups.findIndex((g) => g?.hooks?.some?.(isOurs))
    if (first < 0) continue
    groups.forEach((g, i) => {
      if (i > first && !(g?.hooks?.length && g.hooks.every(isOurs))) moved.push(`${event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}:${i}`)
    })
  }
  return moved
}

export function countOurHooks(hooks) {
  let n = 0
  for (const groups of Object.values(hooks ?? {})) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) for (const h of group?.hooks ?? []) if (isOurs(h)) n++
  }
  return n
}

// `events` defaults to the set every importer of the default home accepts (see claudeEventsFor).
export function mergeClaudeSettings(settings, events = SHARED_CLAUDE_EVENTS) {
  const next = { ...(settings ?? {}) }
  const command = hookCommand()
  next.hooks = placeOurs(next.hooks, events, (spec) => ({ matcher: spec.matcher, hooks: [{ type: 'command', command, timeout: spec.timeout }] }))
  return next
}

// `created` is what install recorded for this file (createdBy); without it, keys and objects left
// empty are dropped.
export function unmergeClaudeSettings(settings, created = null) {
  const next = { ...(settings ?? {}) }
  const hooks = withoutOurHooks(next.hooks, created)
  if (Object.keys(hooks).length || (created && !created.hooksKey)) next.hooks = hooks
  else delete next.hooks
  return next
}

const CODEX_DESCRIPTION = 'agent-mods: cross-agent session tracker, assumptions, ideas, design decisions'

// The description goes only into a hooks.json install creates; a user's own file gets hooks only.
export function mergeCodexHooks(file) {
  const next = file ? { ...file } : { description: CODEX_DESCRIPTION }
  const command = hookCommand('codex')
  next.hooks = placeOurs(next.hooks, CODEX_EVENTS, (spec) => {
    const group = { hooks: [{ type: 'command', command, timeout: spec.timeout }] }
    if (spec.matcher) group.matcher = spec.matcher
    return group
  })
  return next
}

// Returns null when the file held nothing but what install wrote (the caller deletes it).
export function unmergeCodexHooks(file, created = null) {
  const hooks = withoutOurHooks(file?.hooks, created)
  const otherKeys = Object.keys(file ?? {}).filter((k) => k !== 'hooks' && k !== 'description')
  if (created?.file !== false && !Object.keys(hooks).length && !otherKeys.length) return null
  return { ...(file ?? {}), hooks }
}

export function mcpEntry(extraEnv = {}) {
  return { command: MCP_COMMAND.command, args: [...MCP_COMMAND.args], env: { ...extraEnv } }
}

export function sameMcpEntry(entry) {
  return Boolean(entry && entry.command === MCP_COMMAND.command && Array.isArray(entry.args) && entry.args.join(' ') === MCP_COMMAND.args.join(' '))
}

// { mcpServers: {...} } files: Devin's mcp_config.json and Claude's .claude.json shape.
export function mergeMcpServers(file, extraEnv) {
  const next = { ...(file ?? {}) }
  next.mcpServers = { ...(next.mcpServers ?? {}), [SERVER_NAME]: mcpEntry(extraEnv) }
  return next
}

export function unmergeMcpServers(file) {
  if (!file?.mcpServers?.[SERVER_NAME]) return file
  const servers = { ...file.mcpServers }
  delete servers[SERVER_NAME]
  return { ...file, mcpServers: servers }
}

export function codexTomlHasServer(text) {
  return /^\s*\[mcp_servers\.("agent-mods"|agent-mods)\]\s*$/m.test(String(text ?? ''))
}

// Grok cannot take context at session start, so its homes get a static rules file instead.
export const GROK_RULES = `# agent-mods (installed on this machine)

Shared tools from the agent-mods MCP server, used by Claude Code, Codex, Grok and Devin sessions on
this machine. Reach them with search_tool, then use_tool with tool_name "agent-mods__<tool>".

- At the start of a task in a repo, call \`briefing\` once (pass cwd): it lists other agent sessions
  working in the same repo, project rules learned from corrected assumptions, design decisions and
  messages for you. Grok gets no session-start context from hooks, so this call replaces it.
- When you make an assumption the user did not state, call \`log_assumption\` once and keep working.
  This never replaces asking where your instructions or the project rules say to ask first.
- When you notice a side task outside the current scope, call \`shelve_idea\` instead of doing it.
- Before editing files another session may hold, check \`sessions\` (action "check_file").

Skills: /idea, /tracker, /monitor, /assumptions, /plain, /enhance, /design-decisions, /clawd.
`
