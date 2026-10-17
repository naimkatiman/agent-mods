// Where code and data live. Data defaults to %USERPROFILE%\.agent-mods and can be
// redirected with AGENT_MODS_HOME (tests point it at a temp dir).
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const CODE_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

export function storeRoot(env = process.env) {
  const override = env.AGENT_MODS_HOME
  return path.resolve(override && override.trim() ? override.trim() : path.join(os.homedir(), '.agent-mods'))
}

// Forward-slash form of a code path, safe inside hook command strings on every shell here.
export function slashPath(p) {
  return p.replace(/\\/g, '/')
}

export const HOOK_SCRIPT = slashPath(path.join(CODE_ROOT, 'bin', 'agent-mods-hook.mjs'))
export const MCP_SCRIPT = slashPath(path.join(CODE_ROOT, 'bin', 'mcp-server.mjs'))
export const CLI_SCRIPT = slashPath(path.join(CODE_ROOT, 'bin', 'agent-mods.mjs'))
