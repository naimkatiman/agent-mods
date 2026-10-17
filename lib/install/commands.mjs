// install / uninstall / doctor CLI commands.
import { runInstall } from './install.mjs'
import { runDoctor } from './doctor.mjs'
import { discoverHosts } from './hosts.mjs'
import { trustCodexHooks } from './codex-trust.mjs'

const AGENT_NAMES = ['claude', 'codex', 'grok', 'devin']

function parseOnly(value) {
  if (!value || value === true) return null
  const list = String(value).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const bad = list.filter((a) => !AGENT_NAMES.includes(a))
  if (bad.length) throw new Error(`Unknown agent(s): ${bad.join(', ')}. Use: ${AGENT_NAMES.join(', ')}`)
  return list
}

function printResults(c, results, dryRun) {
  if (c.json) return c.printJson(results)
  const width = Math.max(...results.map((r) => r.status.length), 6)
  for (const r of results) {
    c.print(`${r.status.padEnd(width)}  ${r.agent.padEnd(7)} ${r.target}${r.detail ? `  (${r.detail})` : ''}`)
  }
  const failed = results.filter((r) => r.status === 'failed')
  c.print('')
  c.print(dryRun ? 'Dry run: nothing was written.' : failed.length ? `${failed.length} step(s) failed; see above.` : 'Done.')
}

const NEXT_STEPS = [
  'Next:',
  '- Codex runs new hooks only after you trust them: `agent-mods trust-codex` does what /hooks does, for the agent-mods hooks only, in every CODEX_HOME.',
  '- Restart running agent sessions (or start new ones) so they load the hooks, MCP server and skills.',
  '- `agent-mods doctor --deep` checks every agent, including what Grok actually loads.',
  '- Optional: `agent-mods notify on` (finish toasts), `agent-mods plain expert` (plain-talk rules), `agent-mods clawd watch` (pets pane).',
]

export const INSTALL_COMMANDS = [
  {
    name: 'install',
    summary: 'Register hooks, MCP server, skills and rules for Claude, Codex, Grok and Devin',
    usage: 'agent-mods install [--dry-run] [--only claude,codex,grok,devin] [--json]',
    run: (c) => {
      const dryRun = Boolean(c.flags['dry-run'])
      const { results } = runInstall({ only: parseOnly(c.flags.only), dryRun, store: c.store })
      printResults(c, results, dryRun)
      if (!dryRun && !c.json) {
        c.print('')
        for (const line of NEXT_STEPS) c.print(line)
      }
      return results.some((r) => r.status === 'failed') ? 1 : 0
    },
  },
  {
    name: 'uninstall',
    summary: 'Remove everything install added (keeps your data in ~/.agent-mods)',
    usage: 'agent-mods uninstall [--dry-run] [--only claude,codex,grok,devin] [--json]',
    run: (c) => {
      const dryRun = Boolean(c.flags['dry-run'])
      const { results } = runInstall({ only: parseOnly(c.flags.only), dryRun, uninstall: true, store: c.store })
      printResults(c, results, dryRun)
      if (!dryRun && !c.json) c.print(`Your data is still in ${c.store.root}. Delete that folder yourself to remove it.`)
      return results.some((r) => r.status === 'failed') ? 1 : 0
    },
  },
  {
    name: 'doctor',
    summary: 'Check every agent home is wired and each agent hook has fired (--deep asks Grok)',
    usage: 'agent-mods doctor [--deep] [--json]',
    run: async (c) => {
      const deep = Boolean(c.flags.deep)
      const { checks } = runDoctor({ store: c.store, deep, now: c.now })
      // Trust is Codex's call: config.toml only shows that a trusted_hash exists, not that it still
      // matches the hook. So ask Codex itself (~0.6 s per home).
      for (const r of await trustCodexHooks({ homes: discoverHosts().codexHomes, dryRun: true })) {
        const ok = r.ok && r.status.startsWith('already trusted')
        checks.push({ agent: 'codex', item: `hooks trusted in ${r.home}`, ok, detail: ok ? r.status : `${r.status}; run agent-mods trust-codex` })
      }
      if (c.json) {
        c.printJson(checks)
      } else {
        for (const k of checks) {
          const mark = k.agent === 'note' ? '·' : k.ok ? '✓' : '✗'
          c.print(`${mark} ${k.agent.padEnd(6)} ${k.item}${k.detail ? `  (${k.detail})` : ''}`)
        }
      }
      return checks.some((k) => !k.ok && k.agent !== 'note') ? 1 : 0
    },
  },
  {
    name: 'trust-codex',
    summary: "Trust the agent-mods hooks in every CODEX_HOME through Codex's own /hooks calls",
    usage: 'agent-mods trust-codex [--dry-run] [--json]',
    run: async (c) => {
      const results = await trustCodexHooks({ homes: discoverHosts().codexHomes, dryRun: Boolean(c.flags['dry-run']), now: c.now })
      if (c.json) c.printJson(results)
      else for (const r of results) c.print(`${r.ok ? '✓' : '✗'} ${r.home}  ${r.status}`)
      return results.every((r) => r.ok) ? 0 : 1
    },
  },
]
