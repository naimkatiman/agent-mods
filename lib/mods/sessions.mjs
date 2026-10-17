// sessions: session-tracker + session-monitor for every agent, over one store.
//
// Each agent session keeps one public record (sessions/<agent>__<id>.json, shape in
// docs/CONTRACT.md) written only by its own hooks and by session_status on its behalf. From those
// records every session learns who else works in the repo (a briefing at session start, in place of
// Claude's band and pane), gets a note after an edit when another live session in the same worktree
// changed that file in the last 30 minutes, and can leave a one-line message for any other session.
// Claude's and Grok's own live registries fill the machine-wide view for sessions with no record.
import path from 'node:path'
import { readJson } from '../core/fsx.mjs'
import { canonicalPath, relativeTo } from '../core/project.mjs'
import { listRecords, readRecord, resolveCallerSession, updateRecord } from '../core/session-records.mjs'
import { canInjectContext } from '../core/agents.mjs'
import { redact } from '../core/redact.mjs'
import { clip, tail } from '../core/text.mjs'
import {
  baseRecord,
  buildBriefing,
  clashPeers,
  deliverInbox,
  describe,
  fileClashes,
  findSessions,
  listSessions,
  maybePrune,
  pruneNow,
  resumeCandidates,
  sendMessage,
  sendResultData,
  sendResultText,
  takeInbox,
  withProject,
} from './sessions-data.mjs'
import {
  CLASH_MS,
  agoShort,
  canResume,
  clashNote,
  clashToast,
  doingOf,
  findClash,
  frameMessage,
  label,
  nameOf,
  nextOf,
  peerText,
  quotedName,
  renderMonitor,
  resumeCommand,
  withEdit,
  withFile,
} from './sessions-text.mjs'

const SCOPES = ['worktree', 'repo', 'all']
const SHELLS = ['powershell', 'bash', 'cmd']
const MAX_NOTES = 3

// --- hooks ---------------------------------------------------------------------------------------

function identity(ctx) {
  return { agent: ctx.session.agent, id: ctx.session.id, key: ctx.session.key, home: ctx.ev.home }
}

// A record first created by a later event (SessionStart missed or not registered) still gets placed.
function placed(ctx, current) {
  const next = baseRecord(identity(ctx), current, ctx.now)
  return next.worktreeKey ? next : withProject(next, ctx.project)
}

function readOnly(ctx) {
  ctx.record = readRecord(ctx.store, ctx.session.key)
}

// Grok TUI lists its sessions with their pid in <home>/active_sessions.json (read-only here).
// Devin's ACP Grok sessions never register; liveness then falls back to the heartbeat TTL.
function grokPid(home, id) {
  if (!home) return null
  let list = null
  try {
    list = readJson(path.join(home, 'active_sessions.json'), null)
  } catch {}
  const hit = Array.isArray(list) ? list.find((s) => s && String(s.session_id) === id) : null
  const pid = Number(hit?.pid)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

function pidFor(ev, id) {
  // An empty CLAUDE_PID normalizes to 0, which is no process.
  if (ev.agent === 'claude') return Number.isInteger(ev.pid) && ev.pid > 0 ? ev.pid : null
  if (ev.agent === 'grok') return grokPid(ev.home, id)
  return null
}

// No model call writes titles any more (the original asked haiku every turn): the agent's own
// session title wins, else the first prompt, and session_status always wins over both.
function titled(record, ev, prompt) {
  if (ev.sessionTitle && ev.sessionTitle.trim() && record.titleSource !== 'status') {
    return { ...record, title: clip(redact(ev.sessionTitle), 60), titleSource: 'agent' }
  }
  if (!record.title && prompt) return { ...record, title: clip(redact(prompt), 40), titleSource: 'prompt' }
  return record
}

function sessionStart(ctx) {
  const { ev, store, now, session } = ctx
  if (ev.isSubagent) return readOnly(ctx)
  const pid = pidFor(ev, session.id)
  // A resume keeps startedAt, turns, title, tasks and files; the process (and pid) is new.
  ctx.record = updateRecord(store, session.key, (current) => {
    const next = withProject(baseRecord(identity(ctx), current, now), ctx.project)
    return titled({ ...next, pid, endedAt: null, state: 'idle', waitingFor: null }, ev, null)
  })
  try {
    maybePrune(store, now)
  } catch (err) {
    ctx.log(`sessions prune: ${err?.stack ?? err}`)
  }
  const parts = []
  const briefing = buildBriefing(store, { project: ctx.project, key: session.key, record: ctx.record, now })
  if (briefing) parts.push(briefing)
  // A message is claimed only on an event that really reaches the model (not Grok's SessionStart),
  // or it would sit in the runtime queue, gone from the inbox and from briefing.
  if (canInjectContext(ev.agent, ev.event)) parts.push(...deliverInbox(store, session.key, now))
  if (parts.length) ctx.out.context.push(parts.join('\n\n'))
  const next = nextOf(ctx.record)
  if (ctx.record.turns && next) ctx.out.notice.push(`↺ Resuming "${quotedName(nameOf(ctx.record), 60)}" · Next: ${peerText(next, 120)}`)
}

function userPromptSubmit(ctx) {
  const { ev, store, now, session } = ctx
  if (ev.isSubagent) return readOnly(ctx)
  // Blank continuations keep the last real prompt and do not count as a turn.
  const prompt = typeof ev.prompt === 'string' && ev.prompt.trim() ? ev.prompt : null
  ctx.record = updateRecord(store, session.key, (current) => {
    let next = withProject(baseRecord(identity(ctx), current, now), ctx.project)
    next = { ...next, endedAt: null, state: 'working', waitingFor: null, turnStartedAt: now }
    if (prompt) next = { ...next, lastPrompt: clip(redact(prompt), 300), turns: (next.turns ?? 0) + 1 }
    if (next.agent === 'grok' && !next.pid) next = { ...next, pid: grokPid(ev.home, session.id) }
    return titled(next, ev, prompt)
  })
  if (!canInjectContext(ev.agent, ev.event)) return
  const messages = deliverInbox(store, session.key, now)
  if (messages.length) ctx.out.context.push(messages.join('\n'))
}

// Agents that cannot take context at prompt time (Grok) get their messages with the next tool result.
function lateInbox(ctx) {
  const { ev, store, now, session } = ctx
  if (ev.isSubagent || canInjectContext(ev.agent, 'UserPromptSubmit') || !canInjectContext(ev.agent, ev.event)) return
  const messages = deliverInbox(store, session.key, now)
  if (messages.length) ctx.out.context.push(messages.join('\n'))
}

function postToolUse(ctx) {
  const { ev, store, now, session } = ctx
  lateInbox(ctx)
  // Subagent edits are not tracked (as in the original), and an edit that failed or was denied
  // changed nothing (the original recorded it before the tool ran).
  const main = !ev.isSubagent && !ev.toolFailed
  const todos = main && Array.isArray(ev.todos) ? ev.todos : null
  const edits = main ? ev.edits ?? [] : []
  if (!todos && !edits.length) return readOnly(ctx)
  const before = readRecord(store, session.key)
  const worktreeKey = before?.worktreeKey ?? ctx.project.worktreeKey
  const rels = edits.map((e) => relativeTo(worktreeKey, e.path)).filter(Boolean)
  // Peers are read before our own record lock: only this session writes its record, so holding the
  // lock across every other record read would buy nothing.
  const peers = rels.length ? clashPeers(store, { worktreeKey, excludeKey: session.key, now }) : []
  const clashes = []
  ctx.record = updateRecord(store, session.key, (current) => {
    let next = { ...placed(ctx, current), endedAt: null, state: 'working', waitingFor: null }
    if (todos) next = { ...next, tasks: todos.map((t, i) => ({ id: t.id ?? `todo-${i}`, text: clip(redact(t.text), 200), status: t.status })) }
    for (const rel of rels) {
      const clash = findClash(rel, next.edits, peers, now)
      if (clash) clashes.push(clash)
      next = { ...next, edits: withEdit(next.edits, rel, now), files: withFile(next.files, rel) }
    }
    return next
  })
  for (const clash of clashes.slice(0, MAX_NOTES)) {
    ctx.out.context.push(clashNote(clash, now))
    ctx.out.notice.push(clashToast(clash, now))
  }
}

function stop(ctx) {
  const { ev, store, now, session } = ctx
  if (ev.isSubagent) return readOnly(ctx)
  ctx.record = updateRecord(store, session.key, (current) => {
    let next = { ...placed(ctx, current), endedAt: null, state: 'idle', waitingFor: null }
    if (ev.lastAssistantMessage && ev.lastAssistantMessage.trim()) next = { ...next, lastAnswer: tail(redact(ev.lastAssistantMessage)) }
    // Without the per-turn summary, the task list is the best doing/next there is.
    if (next.tasks.length) {
      next = {
        ...next,
        doing: next.tasks.find((t) => t.status === 'in_progress')?.text ?? null,
        next: next.tasks.find((t) => t.status === 'pending')?.text ?? null,
      }
    }
    return next
  })
}

// Notifications that do not mean the session is blocked on its user. idle_prompt fires after a
// minute of plain idleness: treating it as "needs you" would turn every finished session into one,
// where the monitor keeps needs-you (registry status 'waiting') apart from done ('idle').
const NOT_WAITING = new Set(['idle_prompt', 'auth_success', 'task_complete'])

// A turn that ended without Stop (an API error, a user abort) is over all the same.
function settle(ctx) {
  const { ev, store, session } = ctx
  if (ev.isSubagent) return readOnly(ctx)
  ctx.record = updateRecord(store, session.key, (current) => ({ ...placed(ctx, current), endedAt: null, state: 'idle', waitingFor: null }))
}

function notification(ctx) {
  const { ev, store, session } = ctx
  // idle_prompt is also the backstop for a turn that ended without Stop.
  if (!ev.isSubagent && ev.notificationType === 'idle_prompt' && readRecord(store, session.key)?.state === 'working') return settle(ctx)
  if (ev.isSubagent || NOT_WAITING.has(ev.notificationType)) return readOnly(ctx)
  ctx.record = updateRecord(store, session.key, (current) => ({
    ...placed(ctx, current),
    endedAt: null,
    state: 'waiting',
    waitingFor: clip(ev.message || ev.notificationType || 'input', 80),
  }))
}

function sessionEnd(ctx) {
  const { ev, store, now, session } = ctx
  // Grok and Claude also fire SessionEnd when a subagent finishes.
  if (ev.isSubagent) return readOnly(ctx)
  ctx.record = updateRecord(store, session.key, (current) =>
    current ? { ...baseRecord(identity(ctx), current, now), endedAt: now, state: 'ended', waitingFor: null } : undefined,
  )
}

// --- MCP tools -----------------------------------------------------------------------------------

function callerOf(args, m, project) {
  try {
    return m.caller(args, project)
  } catch (err) {
    m.log(`sessions caller: ${err?.stack ?? err}`)
    return null
  }
}

const DEVIN_NOTE = 'The devin CLI ships inside Devin Desktop at <install>/resources/app/extensions/windsurf/devin/bin/devin.exe and is not on PATH by default.'

function resumeResult(store, { ref, shell, env }) {
  const shellName = SHELLS.includes(shell) ? shell : 'powershell'
  if (!ref) return { text: 'resume_command needs an id (session id, 6+ character prefix or title).', isError: true }
  const matches = findSessions(resumeCandidates(store, env), ref)
  if (!matches.length) return { text: `No session matches "${peerText(ref, 60)}".`, isError: true }
  if (matches.length > 1) {
    return {
      text: `Several sessions match; use a full id:\n${matches.slice(0, 10).map((s) => `- ${describe(s)} ${peerText(s.id, 120)}`).join('\n')}`,
      data: { command: null, candidates: matches.slice(0, 10).map((s) => ({ agent: s.agent, id: s.id })) },
      isError: true,
    }
  }
  const s = matches[0]
  if (!canResume(s.agent)) return { text: `${label(s.agent)} sessions cannot be reopened from a terminal.`, isError: true }
  const command = resumeCommand({ agent: s.agent, id: s.id, cwd: s.cwd ?? '', home: s.home ?? null }, shellName)
  return {
    text: s.agent === 'devin' ? `${command}\n${DEVIN_NOTE}` : command,
    data: { command, shell: shellName, session: { agent: s.agent, id: s.id, cwd: s.cwd ?? '' } },
  }
}

function checkFileResult(store, { file, project, me, now }) {
  if (!file || !String(file).trim()) return { text: 'check_file needs a path.', isError: true }
  const worktreeKey = me?.worktreeKey ?? project.worktreeKey
  const rel = relativeTo(worktreeKey, canonicalPath(file, project.cwd))
  const peers = clashPeers(store, { worktreeKey, excludeKey: me?.key, now })
  const clash = findClash(rel, me?.edits, peers, now)
  if (!clash) {
    return {
      text: `Clear: no other live session in this worktree edited ${rel} in the last 30 minutes (after your own last edit of it).`,
      data: { clash: false, file: rel },
    }
  }
  const note = clashNote(clash, now)
  return {
    text: note,
    data: {
      clash: true,
      file: rel,
      other: { agent: clash.other.agent, id: clash.other.id, name: peerText(nameOf(clash.other), 60), doing: peerText(doingOf(clash.other) ?? '', 120) || null },
      editedAgoSec: Math.max(0, Math.round((now - clash.at) / 1000)),
      note,
    },
  }
}

function messageData(m) {
  return {
    from: { agent: m.from?.agent ?? null, id: m.from?.id ?? null, title: m.from?.title ? peerText(m.from.title, 60) : null },
    at: m.at,
    text: peerText(m.text, 500),
  }
}

function inboxResult(store, { caller, now, peek = false }) {
  if (!caller?.key) return { text: 'Could not tell which session you are: pass session_id (your session id).', isError: true }
  const messages = takeInbox(store, caller.key, now, { peek })
  if (!messages.length) return { text: 'No peer messages.', data: { messages: [] } }
  return { text: messages.map(frameMessage).join('\n'), data: { messages: messages.map(messageData) } }
}

const STATUS_WORDS = {
  completed: 'completed',
  complete: 'completed',
  done: 'completed',
  in_progress: 'in_progress',
  active: 'in_progress',
  doing: 'in_progress',
}

function tasksFrom(list) {
  return list
    .filter((t) => t && typeof t.text === 'string' && t.text.trim())
    .slice(0, 50)
    .map((t, i) => ({
      id: `todo-${i}`,
      text: clip(redact(t.text), 200),
      status: STATUS_WORDS[String(t.status ?? '').toLowerCase().replace(/[\s-]+/g, '_')] ?? 'pending',
    }))
}

function field(value, max) {
  if (typeof value !== 'string') return undefined
  return value.trim() ? clip(redact(value), max) : null
}

// A session id given here becomes part of resume commands the user pastes into a shell, and a cwd is
// printed to the terminal: only plain ids, and no control characters.
const SESSION_ID = /^[\w.-]{1,128}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

function sessionStatus(args, m) {
  if (args.session_id !== undefined && !SESSION_ID.test(String(args.session_id))) {
    return { text: 'session_id must be a plain id: letters, digits, dot, dash or underscore.', isError: true }
  }
  if (typeof args.cwd === 'string' && CONTROL.test(args.cwd)) return { text: 'cwd must not contain control characters.', isError: true }
  const project = m.project(args.cwd)
  const caller = callerOf(args, m, project)
  if (!caller?.agent || !caller?.id) {
    return { text: 'Could not tell which session you are: pass session_id (your session id).', isError: true }
  }
  const updates = {}
  const title = field(args.title, 60)
  if (title !== undefined) Object.assign(updates, { title, titleSource: title ? 'status' : null })
  for (const name of ['done', 'doing', 'next']) {
    const value = field(args[name], 100)
    if (value !== undefined) updates[name] = value
  }
  if (Array.isArray(args.tasks)) updates.tasks = tasksFrom(args.tasks)
  const record = updateRecord(m.store, caller.key, (current) => {
    const next = baseRecord({ agent: caller.agent, id: caller.id, key: caller.key, home: null }, current, m.now)
    return { ...(next.worktreeKey ? next : withProject(next, project)), ...updates }
  })
  return {
    text: `Saved for ${describe(record)}.`,
    data: { ok: true, session: { agent: record.agent, id: record.id }, title: record.title, done: record.done, doing: record.doing, next: record.next },
  }
}

function sendTool(args, m) {
  const project = m.project(args.cwd)
  const caller = callerOf(args, m, project)
  const from = caller?.id
    ? { agent: caller.agent, id: caller.id, title: caller.record ? nameOf(caller.record) : null }
    : { agent: m.agent ?? null, id: null, title: null }
  const result = sendMessage(m.store, { to: args.to, text: args.text, from, now: m.now })
  return { text: sendResultText(result), data: sendResultData(result), isError: result.status !== 'queued' }
}

// This mod's part of the core briefing tool: other sessions and clashes, then the caller's messages.
function briefingPart(m, { project, caller }) {
  const briefing = buildBriefing(m.store, { project, key: caller?.key ?? null, record: caller?.record ?? null, now: m.now })
  const messages = caller?.key ? deliverInbox(m.store, caller.key, m.now) : []
  return [briefing, ...messages]
}

function sessionsTool(args, m) {
  const action = args.action ?? 'list'
  const project = m.project(args.cwd)
  const caller = callerOf(args, m, project)
  if (action === 'list') {
    return listSessions(m.store, {
      scope: SCOPES.includes(args.scope) ? args.scope : 'worktree',
      project,
      me: caller?.record ?? null,
      now: m.now,
      includeEnded: Boolean(args.include_ended),
      limit: Number.isInteger(args.limit) ? args.limit : undefined,
      env: m.env,
    })
  }
  if (action === 'check_file') return checkFileResult(m.store, { file: args.path, project, me: caller?.record ?? null, now: m.now })
  if (action === 'resume_command') return resumeResult(m.store, { ref: args.id, shell: args.shell, env: m.env })
  if (action === 'inbox') return inboxResult(m.store, { caller, now: m.now })
  return { text: `Unknown action: ${peerText(action, 40)}. Use list, check_file, resume_command or inbox.`, isError: true }
}

const TOOLS = [
  {
    name: 'sessions',
    description:
      'Agent sessions on this machine (Claude Code, Codex, Grok, Devin). list: who is working where, on what (scope worktree, repo or all); check_file: did another live session edit this file in the last 30 min; resume_command: command that reopens a session; inbox: your peer messages.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'check_file', 'resume_command', 'inbox'] },
        scope: { type: 'string', enum: SCOPES, description: 'list: default worktree' },
        path: { type: 'string', description: 'check_file: file path' },
        id: { type: 'string', description: 'resume_command: session id, 6+ char prefix or title' },
        shell: { type: 'string', enum: SHELLS, description: 'resume_command: default powershell' },
        include_ended: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        cwd: { type: 'string' },
        session_id: { type: 'string', description: 'your own session id, if known' },
      },
      required: ['action'],
    },
    run: sessionsTool,
  },
  {
    name: 'session_status',
    description:
      'Publish where your session stands so other agent sessions see it; call at milestones. Each field is optional and replaces the previous value.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '2-5 word name for the overall work' },
        done: { type: 'string', description: 'what has been accomplished so far, under 100 chars' },
        doing: { type: 'string', description: 'what is in progress or unfinished right now, or "waiting for user", under 100 chars' },
        next: { type: 'string', description: 'the concrete next step, under 100 chars' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: { text: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } },
            required: ['text'],
          },
        },
        session_id: { type: 'string' },
        cwd: { type: 'string' },
      },
    },
    run: sessionStatus,
  },
  {
    name: 'send_message',
    description:
      'Queue a one-line message for another agent session (any agent); it is shown to that session with its next prompt. Send only what the user asked you to send.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'session id, 6+ char id prefix, or exact title' },
        text: { type: 'string', minLength: 1, maxLength: 500 },
        cwd: { type: 'string' },
      },
      required: ['to', 'text'],
    },
    run: sendTool,
  },
]

// --- CLI -----------------------------------------------------------------------------------------

const SUBCOMMANDS = new Set(['list', 'watch', 'send', 'inbox', 'resume', 'clashes', 'prune'])

function usage(name) {
  return [
    `Usage: agent-mods ${name} [list] [--all|--repo] [--ended] [--limit n] [--json] [--cwd <dir>]`,
    `       agent-mods ${name} watch [--all|--repo] [--interval 2000]`,
    `       agent-mods ${name} send <to> <text...>`,
    `       agent-mods ${name} inbox [--peek] [--session <id>]`,
    `       agent-mods ${name} resume <id> [--shell powershell|bash|cmd] [--copy]`,
    `       agent-mods ${name} clashes [--minutes 30] [--all|--repo] [--json]`,
    `       agent-mods ${name} prune`,
  ].join('\n')
}

// The terminal is not a session, unless --session names one or the CLI runs inside an agent's
// shell tool (which passes the agent's session id in its env).
function cliCaller(c) {
  if (typeof c.flags.session === 'string' && c.flags.session) {
    const matches = findSessions(listRecords(c.store), c.flags.session)
    return matches.length === 1 ? { agent: matches[0].agent, id: matches[0].id, key: matches[0].key, record: matches[0] } : null
  }
  if (!c.agent) return null
  return resolveCallerSession(c.store, { agent: c.agent, env: c.env, project: c.project, now: c.now })
}

// The monitor's jump copied through Claude's UI; a terminal pipes to the OS clipboard instead.
// clip.exe reads ANSI unless the input starts with a UTF-16LE BOM, so non-ASCII paths go as UTF-16.
export async function copyText(text, { spawn, platform = process.platform } = {}) {
  const run = spawn ?? (await import('node:child_process')).spawnSync
  // eslint-disable-next-line no-control-regex
  const ascii = /^[\x00-\x7f]*$/.test(text)
  if (platform === 'win32') {
    const input = ascii ? text : Buffer.from(`${String.fromCharCode(0xfeff)}${text}`, 'utf16le')
    return run('clip.exe', [], { input, windowsHide: true }).status === 0
  }
  if (platform === 'darwin') return run('pbcopy', [], { input: text }).status === 0
  return false
}

function watch(c, scope) {
  const interval = Math.max(500, Number.parseInt(c.flags.interval, 10) || 2000)
  const color = Boolean(process.stdout.isTTY) && !c.env.NO_COLOR
  const me = cliCaller(c)?.record ?? null
  const draw = () => {
    const now = Date.now()
    const { data } = listSessions(c.store, { scope, project: c.project, me, now, limit: 200, env: c.env })
    const frame = renderMonitor(data.sessions, { now, where: data.where, width: process.stdout.columns || 0, color })
    c.print(`\x1b[H\x1b[2J${frame}\n\n(Ctrl+C exits)`)
  }
  return new Promise((resolve) => {
    c.print('\x1b[?25l')
    draw()
    const timer = setInterval(() => {
      try {
        draw()
      } catch (err) {
        c.error(String(err?.message ?? err))
      }
    }, interval)
    process.once('SIGINT', () => {
      clearInterval(timer)
      c.print('\x1b[?25h')
      resolve(0)
    })
  })
}

function printClashes(c, scope) {
  const minutes = Math.max(1, Number.parseInt(c.flags.minutes, 10) || CLASH_MS / 60_000)
  const groups = fileClashes(c.store, { scope, project: c.project, now: c.now, windowMs: minutes * 60_000 })
  if (c.json) {
    c.printJson({
      minutes,
      clashes: groups.map((g) => ({
        file: g.file,
        worktree: g.worktree,
        edits: g.edits.map((e) => ({ agent: e.session.agent, id: e.session.id, name: peerText(nameOf(e.session), 60), agoSec: Math.max(0, Math.round((c.now - e.at) / 1000)) })),
      })),
    })
    return 0
  }
  if (!groups.length) {
    c.print(`No file clashes in the last ${minutes}m.`)
    return 0
  }
  c.print(`⚠ File clashes (last ${minutes}m)`)
  for (const g of groups) {
    const where = scope === 'worktree' ? '' : `[${path.posix.basename(g.worktree ?? '')}] `
    c.print(`${where}${peerText(g.file, 160)} · ${g.edits.map((e) => `${describe(e.session)} ${agoShort(c.now - e.at)} ago`).join(' · ')}`)
  }
  return 0
}

async function runCliCommand(c, name, defaultScope) {
  const [first, ...rest] = c.positionals
  if (first !== undefined && !SUBCOMMANDS.has(first)) {
    c.error(`Unknown subcommand: ${first}\n\n${usage(name)}`)
    return 2
  }
  const sub = first ?? 'list'
  const args = first === undefined ? [] : rest
  const scope = c.flags.all ? 'all' : c.flags.repo ? 'repo' : c.flags.worktree ? 'worktree' : defaultScope

  if (sub === 'list') {
    const limit = c.flags.limit !== undefined ? Number.parseInt(c.flags.limit, 10) : undefined
    const caller = cliCaller(c)
    const result = listSessions(c.store, {
      scope,
      project: c.project,
      me: caller?.record ?? null,
      now: c.now,
      includeEnded: Boolean(c.flags.ended),
      limit: Number.isInteger(limit) ? limit : undefined,
      env: c.env,
    })
    if (c.json) c.printJson(result.data)
    else c.print(result.text)
    return 0
  }
  if (sub === 'watch') return watch(c, scope)
  if (sub === 'send') {
    const [to, ...words] = args
    if (!to || !words.length) {
      c.error(`Usage: agent-mods ${name} send <to> <text...>`)
      return 2
    }
    const caller = cliCaller(c)
    const from = caller?.id
      ? { agent: caller.agent, id: caller.id, title: caller.record ? nameOf(caller.record) : null }
      : { agent: 'cli', id: null, title: null }
    const result = sendMessage(c.store, { to, text: words.join(' '), from, now: c.now })
    if (c.json) c.printJson(sendResultData(result))
    else c.print(sendResultText(result))
    return result.status === 'queued' ? 0 : 1
  }
  if (sub === 'inbox') {
    const result = inboxResult(c.store, { caller: cliCaller(c), now: c.now, peek: Boolean(c.flags.peek) })
    if (result.isError) {
      c.error(`${result.text.replace('pass session_id (your session id)', 'pass --session <id>')}`)
      return 2
    }
    if (c.json) c.printJson(result.data)
    else c.print(result.text)
    return 0
  }
  if (sub === 'resume') {
    const result = resumeResult(c.store, { ref: args[0], shell: c.flags.shell, env: c.env })
    if (result.isError) {
      c.error(result.text)
      return 1
    }
    if (c.json) c.printJson(result.data)
    else c.print(result.text)
    if (c.flags.copy) {
      const copied = await copyText(result.data.command).catch(() => false)
      c.error(copied ? 'Copied to the clipboard.' : 'Could not copy: no clipboard tool (clip.exe or pbcopy) answered.')
    }
    return 0
  }
  if (sub === 'clashes') return printClashes(c, scope)
  const removed = pruneNow(c.store, c.now)
  c.print(`Removed ${removed} session record${removed === 1 ? '' : 's'} older than 7 days.`)
  return 0
}

function cliEntry(name, defaultScope, summary) {
  return { name, summary, usage: usage(name), run: (c) => runCliCommand(c, name, defaultScope) }
}

// tracker and monitor are separate entries rather than aliases: the dispatcher does not tell a
// command which name invoked it, and the two default to different scopes.
const CLI = [
  cliEntry('sessions', 'worktree', 'Agent sessions: list | watch | send | inbox | resume | clashes | prune'),
  cliEntry('tracker', 'worktree', 'Sessions in this folder and what each is doing (sessions list)'),
  cliEntry('monitor', 'all', 'Every running agent session on this machine (sessions list --all)'),
]

export default {
  name: 'sessions',
  hooks: {
    SessionStart: sessionStart,
    UserPromptSubmit: userPromptSubmit,
    PostToolUse: postToolUse,
    Stop: stop,
    StopFailure: settle,
    Interrupt: settle,
    Notification: notification,
    SessionEnd: sessionEnd,
  },
  tools: TOOLS,
  cli: CLI,
  briefing: briefingPart,
}
