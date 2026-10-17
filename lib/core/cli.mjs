// CLI dispatcher. Mods contribute commands (cli: [{ name, summary, usage, run(cctx) }]); the core adds
// help, project-key, config and the hook/mcp entry points.
import { agentFromEnv, agentFromName } from './agents.mjs'
import { canonicalPath, projectInfo } from './project.mjs'
import { storeRoot } from './paths.mjs'
import { loadConfig, openStore, setConfigValue } from './store.mjs'

const BOOLEAN_FLAGS = new Set([
  'json', 'all', 'repo', 'worktree', 'ended', 'dry-run', 'yes', 'purge', 'peek', 'copy', 'force', 'help',
  'include-taken', 'all-projects', 'open', 'verbose', 'unchanged', 'no-open', 'shades', 'foreground',
])

const DIR_FLAGS = ['cwd', 'project']

export function parseArgs(argv) {
  const flags = {}
  const positionals = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (token.startsWith('--') && token.length > 2) {
      const eq = token.indexOf('=')
      if (eq > 0) {
        flags[token.slice(2, eq)] = token.slice(eq + 1)
        continue
      }
      const name = token.slice(2)
      const next = argv[i + 1]
      if (BOOLEAN_FLAGS.has(name) || next === undefined || next.startsWith('--')) flags[name] = true
      else {
        flags[name] = next
        i++
      }
      continue
    }
    positionals.push(token)
  }
  return { flags, positionals }
}

export function makeCliContext({ argv, env = process.env, stdout = process.stdout, stderr = process.stderr, now = Date.now() }) {
  const { flags, positionals } = parseArgs(argv)
  const store = openStore(storeRoot(env))
  const dir = DIR_FLAGS.map((name) => flags[name]).find((value) => typeof value === 'string' && value)
  const cwd = canonicalPath(dir || process.cwd())
  return {
    argv,
    flags,
    positionals,
    env,
    // The agent session the command runs for, when it runs in an agent's shell tool.
    agent: agentFromName(flags.agent) ?? agentFromName(env.AGENT_MODS_AGENT) ?? agentFromEnv(env),
    store,
    config: loadConfig(store),
    now,
    cwd,
    project: projectInfo(cwd),
    json: Boolean(flags.json),
    print: (text = '') => stdout.write(`${text}\n`),
    printJson: (value) => stdout.write(`${JSON.stringify(value, null, 2)}\n`),
    error: (text) => stderr.write(`${text}\n`),
  }
}

function helpText(commands) {
  const lines = [
    'agent-mods: the claude-mods features for Claude Code, Codex, Grok and Devin.',
    '',
    'Usage: agent-mods <command> [args] [--json] [--cwd <dir>]',
    '',
  ]
  for (const cmd of commands) lines.push(`  ${cmd.name.padEnd(18)} ${cmd.summary ?? ''}`)
  return lines.join('\n')
}

const CORE_COMMANDS = [
  {
    name: 'project-key',
    summary: 'Show how this folder is keyed (repo, worktree, project id)',
    run: (c) => {
      if (c.json) c.printJson(c.project)
      else {
        c.print(`project   ${c.project.name} (${c.project.projectId})`)
        c.print(`repo      ${c.project.repoKey}`)
        c.print(`worktree  ${c.project.worktreeKey}`)
        c.print(`cwd       ${c.project.cwd}`)
        c.print(`store     ${c.store.path('projects', c.project.projectId)}`)
      }
      return 0
    },
  },
  {
    name: 'config',
    summary: 'config [get|set <key> <json-value>]',
    run: (c) => {
      const [action, key, raw] = c.positionals
      if (!action || action === 'get') {
        c.printJson(key ? key.split('.').reduce((node, part) => node?.[part], c.config) : c.config)
        return 0
      }
      if (action === 'set' && key && raw !== undefined) {
        let value = raw
        try {
          value = JSON.parse(raw)
        } catch {}
        setConfigValue(c.store, key, value)
        c.print(`${key} = ${JSON.stringify(value)}`)
        return 0
      }
      c.error('Usage: agent-mods config [get [key] | set <key> <json-value>]')
      return 2
    },
  },
]

export async function runCli({ argv = process.argv.slice(2), env = process.env, stdout = process.stdout, stderr = process.stderr, mods, extraCommands = [], now = Date.now() } = {}) {
  const commands = [...CORE_COMMANDS, ...extraCommands]
  for (const mod of mods ?? []) for (const cmd of mod.cli ?? []) commands.push(cmd)
  const [name, ...rest] = argv
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    stdout.write(`${helpText(commands)}\n`)
    return 0
  }
  const command = commands.find((c) => c.name === name || (c.aliases ?? []).includes(name))
  if (!command) {
    stderr.write(`Unknown command: ${name}\n\n${helpText(commands)}\n`)
    return 2
  }
  const ctx = makeCliContext({ argv: rest, env, stdout, stderr, now })
  const bare = DIR_FLAGS.find((flag) => ctx.flags[flag] === true)
  if (bare) {
    stderr.write(`--${bare} takes a directory\n`)
    return 2
  }
  if (ctx.flags.help) {
    stdout.write(`${command.usage ?? command.summary ?? name}\n`)
    return 0
  }
  const code = await command.run(ctx)
  return Number.isInteger(code) ? code : 0
}
