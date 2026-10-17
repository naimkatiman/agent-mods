// Zero-dependency MCP server core: newline-delimited JSON-RPC 2.0 over stdio, the framing every MCP
// host here uses (same as continuous-improvement's bin/mcp-server.mjs, proven on this host).
// One server process per agent session; each tool comes from a mod.
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { agentFromName } from './agents.mjs'
import { canonicalPath, projectInfo } from './project.mjs'
import { storeRoot } from './paths.mjs'
import { loadConfig, logError, openStore } from './store.mjs'
import { resolveCallerSession } from './session-records.mjs'
import { wellFormed } from './text.mjs'

export const SERVER_NAME = 'agent-mods'
export const SERVER_VERSION = '0.1.0'
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

export const INSTRUCTIONS = [
  'agent-mods: shared tools across Claude Code, Codex, Grok and Devin sessions on this machine.',
  'Pass `cwd` (your working directory) when a tool takes it.',
  '- When you make an assumption the user did not state, call log_assumption once, then keep working. This never replaces asking where your instructions or the project rules say to ask.',
  '- When you notice a side task outside the current scope, call shelve_idea instead of doing it.',
  '- Before multi-file edits in a repo other agents may be using, call sessions (action list) to see who else is working there.',
  '- If you did not receive an [agent-mods] briefing at session start, call briefing once.',
  '- Before UI work, call design_decisions (action list) and follow what it returns. To let the user choose a visual direction, call design_pick with one SVG mockup per option.',
].join('\n')

// What a session start would have told this session, for agents whose hooks cannot inject it there
// (Grok) and sessions that began before the install. Each mod may export
// briefing(mctx, { project, caller }) -> text | text[] | null: the same standing context its
// SessionStart hook injects, with no side effects beyond delivering the caller's own messages.
const BRIEFING_TOOL = {
  name: 'briefing',
  description:
    'Everything a session start would have told you: other agent sessions in this repo and file clashes, project rules from corrected assumptions, design decisions, answer-style rules, and your pending peer messages. Call once at the start of a task if you got no [agent-mods] briefing when your session started.',
  inputSchema: { type: 'object', properties: { cwd: { type: 'string' }, session_id: { type: 'string' } } },
}
const NOTHING_TO_BRIEF =
  'No other agent sessions are working in this repo, and there is nothing else to brief (no project rules, design decisions or peer messages).'

function briefing(mods, args, m) {
  const project = m.project(args.cwd)
  let caller = null
  try {
    caller = m.caller(args, project)
  } catch (err) {
    m.log(`briefing caller: ${err?.stack ?? err}`)
  }
  const parts = []
  for (const mod of mods) {
    if (!mod.briefing || m.config.mods?.[mod.name] === false) continue
    try {
      parts.push(...[mod.briefing(m, { project, caller })].flat().filter(Boolean))
    } catch (err) {
      m.log(`briefing ${mod.name}: ${err?.stack ?? err}`)
    }
  }
  return { text: parts.join('\n\n') || NOTHING_TO_BRIEF, data: { parts: parts.length } }
}

export function fileUriToPath(uri) {
  try {
    return canonicalPath(fileURLToPath(uri))
  } catch {
    return null
  }
}

export function createMcpServer({ mods, env = process.env, input = process.stdin, output = process.stdout, now = () => Date.now() } = {}) {
  const store = openStore(storeRoot(env))
  const state = {
    agent: agentFromName(env.AGENT_MODS_AGENT) ?? null,
    clientName: null,
    clientCaps: {},
    roots: [],
  }
  const tools = new Map()
  for (const mod of mods) {
    for (const tool of mod.tools ?? []) tools.set(tool.name, { ...tool, mod: mod.name })
  }
  if (mods.some((mod) => mod.briefing)) tools.set(BRIEFING_TOOL.name, { ...BRIEFING_TOOL, run: (args, m) => briefing(mods, args, m) })
  const pending = new Map()
  let nextId = 1

  const send = (message) => output.write(`${JSON.stringify(message, wellFormed)}\n`)

  const defaultCwd = () =>
    state.roots[0] || canonicalPath(env.CLAUDE_PROJECT_DIR) || canonicalPath(env.GROK_WORKSPACE_ROOT) || canonicalPath(process.cwd())

  const makeContext = () => {
    const config = loadConfig(store)
    const t = now()
    return {
      agent: state.agent,
      clientName: state.clientName,
      env,
      store,
      config,
      now: t,
      defaultCwd: defaultCwd(),
      project: (cwd) => projectInfo(cwd || defaultCwd()),
      caller: (args = {}, project) =>
        resolveCallerSession(store, {
          agent: state.agent,
          sessionId: args.session_id,
          env,
          project: project ?? projectInfo(args.cwd || defaultCwd()),
          now: t,
        }),
      log: (message) => logError(store, `mcp: ${message}`),
    }
  }

  function request(method, params) {
    const id = `agent-mods-${nextId++}`
    send({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve(null)
      }, 3000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
    })
  }

  async function refreshRoots() {
    if (!state.clientCaps?.roots) return
    const reply = await request('roots/list', {})
    const roots = reply?.result?.roots
    if (Array.isArray(roots)) state.roots = roots.map((r) => fileUriToPath(r.uri)).filter(Boolean)
  }

  async function callTool(name, args) {
    const tool = tools.get(name)
    if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
    try {
      const result = (await tool.run(args ?? {}, makeContext())) ?? {}
      const text = result.text ?? (result.data !== undefined ? JSON.stringify(result.data, null, 2) : 'ok')
      const reply = { content: [{ type: 'text', text }] }
      // Never structuredContent: Codex 0.162 sends only that JSON to the model and drops the text
      // (codex-rs/protocol/src/models.rs, as_function_call_output_payload). The data rides in _meta,
      // which no client shows the model.
      if (result.data !== undefined && result.data !== null && typeof result.data === 'object' && !Array.isArray(result.data)) {
        reply._meta = { 'agent-mods/data': result.data }
      }
      if (result.isError) reply.isError = true
      return reply
    } catch (err) {
      logError(store, `mcp tool ${name}: ${err?.stack ?? err}`)
      return { content: [{ type: 'text', text: `agent-mods ${name} failed: ${err?.message ?? err}` }], isError: true }
    }
  }

  async function handle(message) {
    if (message.id !== undefined && message.method === undefined) {
      pending.get(message.id)?.(message)
      pending.delete(message.id)
      return
    }
    const { id, method, params = {} } = message
    switch (method) {
      case 'initialize': {
        state.clientName = params.clientInfo?.name ?? null
        state.clientCaps = params.capabilities ?? {}
        state.agent = state.agent ?? agentFromName(state.clientName)
        const asked = params.protocolVersion
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOLS.includes(asked) ? asked : '2024-11-05',
            capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions: INSTRUCTIONS,
          },
        })
        return
      }
      case 'notifications/initialized':
        refreshRoots().catch(() => {})
        return
      case 'notifications/roots/list_changed':
        refreshRoots().catch(() => {})
        return
      case 'ping':
        send({ jsonrpc: '2.0', id, result: {} })
        return
      case 'tools/list':
        send({
          jsonrpc: '2.0',
          id,
          result: {
            tools: [...tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
          },
        })
        return
      case 'tools/call':
        send({ jsonrpc: '2.0', id, result: await callTool(params.name, params.arguments) })
        return
      case 'resources/list':
        send({ jsonrpc: '2.0', id, result: { resources: [] } })
        return
      case 'resources/templates/list':
        send({ jsonrpc: '2.0', id, result: { resourceTemplates: [] } })
        return
      case 'prompts/list':
        send({ jsonrpc: '2.0', id, result: { prompts: [] } })
        return
      default:
        if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
    }
  }

  const rl = createInterface({ input, crlfDelay: Infinity })
  let buffer = ''
  const parse = (text) => {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }
  rl.on('line', (line) => {
    if (!line.trim() && !buffer) return
    let message = buffer ? undefined : parse(line)
    if (message === undefined) {
      buffer += line
      message = parse(buffer)
      if (message === undefined) {
        if (buffer.length > 4_000_000) buffer = ''
        return
      }
    }
    buffer = ''
    Promise.resolve(handle(message)).catch((err) => logError(store, `mcp: ${err?.stack ?? err}`))
  })
  return { tools, state, close: () => rl.close() }
}
