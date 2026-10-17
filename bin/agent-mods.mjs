#!/usr/bin/env node
// The agent-mods CLI. `agent-mods help` lists every command.
import { runCli } from '../lib/core/cli.mjs'
import { MODS } from '../lib/mods/index.mjs'

const argv = process.argv.slice(2)

if (argv[0] === 'hook') {
  await import('./agent-mods-hook.mjs')
} else if (argv[0] === 'mcp') {
  await import('./mcp-server.mjs')
} else {
  const [{ INSTALL_COMMANDS }, { DASHBOARD_COMMANDS }] = await Promise.all([
    import('../lib/install/commands.mjs'),
    import('../lib/dashboard/commands.mjs'),
  ])
  const code = await runCli({ argv, mods: MODS, extraCommands: [...INSTALL_COMMANDS, ...DASHBOARD_COMMANDS] })
  process.exitCode = code
}
