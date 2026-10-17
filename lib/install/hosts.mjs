// Where each agent keeps its config on this host (survey 2026-10-11). Every path derives from
// homeDir/appData so tests can point the installer at a fake home.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HOOK_SCRIPT, MCP_SCRIPT, CLI_SCRIPT } from '../core/paths.mjs'

// Ours are recognised by the entry script's own name, so a renamed checkout or a worktree still matches.
export const MARKER = 'agent-mods-hook.mjs'
export const SERVER_NAME = 'agent-mods'
export const SKILL_MARKER_FILE = '.agent-mods'

function exists(p) {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}

function quoteIfSpaced(p) {
  return /\s/.test(p) ? `"${p}"` : p
}

// The hook command string. No `args` array: Grok skips Claude handlers that set args, and the same
// string must run under Git Bash (Claude), PowerShell 5.1 (Codex, Grok) and cmd.
export function hookCommand(agentFlag) {
  return `node ${quoteIfSpaced(HOOK_SCRIPT)}${agentFlag ? ` --agent ${agentFlag}` : ''}`
}

export const MCP_COMMAND = { command: 'node', args: [MCP_SCRIPT] }

export function discoverHosts({ homeDir = os.homedir(), appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), env = process.env } = {}) {
  const altClaude = ['92', 'gmail', 'robopro']
    .map((name) => path.join(homeDir, '.agent-auth', 'homes', 'claude', name))
    .filter(exists)
  const altCodex = ['92', 'gmail', 'robopro']
    .map((name) => path.join(homeDir, '.agent-auth', 'homes', 'codex', name))
    .filter(exists)
  const claudeHomes = [
    { home: path.join(homeDir, '.claude'), configJson: path.join(homeDir, '.claude.json'), isDefault: true },
    ...altClaude.map((home) => ({ home, configJson: path.join(home, '.claude.json'), isDefault: false })),
  ].filter((h) => exists(h.home))
  const codexHomes = [path.join(homeDir, '.codex'), ...altCodex].filter(exists)
  const grokHomes = [path.join(homeDir, '.grok'), path.join(homeDir, '.grok-tui')].filter(exists)
  const devinConfigDir = path.join(appData, 'devin')
  return {
    homeDir,
    appData,
    claudeHomes,
    codexHomes,
    grokHomes,
    grokExe: [path.join(homeDir, '.grok', 'bin', 'grok.exe'), path.join(homeDir, '.grok', 'bin', 'grok')].find(exists) ?? null,
    devin: exists(devinConfigDir) ? { configDir: devinConfigDir, mcpConfig: path.join(devinConfigDir, 'mcp_config.json') } : null,
    agentsSkillsDir: path.join(homeDir, '.agents', 'skills'),
    claudeSkillsDir: path.join(homeDir, '.claude', 'skills'),
    binDir: path.join(homeDir, 'bin'),
    pathHasBin: String(env.PATH ?? env.Path ?? '')
      .split(path.delimiter)
      .some((p) => path.resolve(p).toLowerCase() === path.join(homeDir, 'bin').toLowerCase()),
    scripts: { hook: HOOK_SCRIPT, mcp: MCP_SCRIPT, cli: CLI_SCRIPT },
  }
}
