// Installer: registers hooks, the MCP server, skills, Grok rules and CLI shims for every agent home on
// this host. Idempotent (ours are found by marker and replaced where they stand), backs up every config
// file it changes (<file>.bak-agent-mods-<epoch>), supports --dry-run, and uninstall removes only what
// it added: what install created in each config file is recorded in the store (install/state.json).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { CODE_ROOT } from '../core/paths.mjs'
import { sleepSync } from '../core/fsx.mjs'
import { discoverHosts, SERVER_NAME, SKILL_MARKER_FILE, MCP_COMMAND } from './hosts.mjs'
import {
  CODEX_EVENTS,
  GROK_RULES,
  claudeEventsFor,
  codexTomlHasServer,
  createdBy,
  hooksAfterOurs,
  mergeClaudeSettings,
  mergeCodexHooks,
  mergeMcpServers,
  sameMcpEntry,
  unmergeClaudeSettings,
  unmergeCodexHooks,
  unmergeMcpServers,
} from './plan.mjs'

export const SKILLS_SRC = path.join(CODE_ROOT, 'skills')
const STATE = 'install/state.json'

// The child gets this process's environment plus `overrides`; an override of undefined removes the
// variable (matched case-insensitively on Windows). The default Claude home must not inherit a
// CLAUDE_CONFIG_DIR from whatever shell runs install, or `claude mcp add` edits an alternate home.
export function childEnv(base, overrides = {}) {
  const env = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    for (const existing of Object.keys(env)) {
      if (process.platform === 'win32' ? existing.toLowerCase() === key.toLowerCase() : existing === key) delete env[existing]
    }
    if (value !== undefined) env[key] = value
  }
  return env
}

// npm shims (claude, codex) are .cmd files, which spawn cannot run directly on Windows.
export function defaultRunner(cmd, args, { env = {}, timeoutMs = 120_000 } = {}) {
  const isExe = /\.exe$/i.test(cmd) || path.isAbsolute(cmd)
  const file = isExe || process.platform !== 'win32' ? cmd : 'cmd.exe'
  const argv = isExe || process.platform !== 'win32' ? args : ['/d', '/s', '/c', cmd, ...args]
  const r = spawnSync(file, argv, {
    env: childEnv(process.env, env),
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  return { code: r.status ?? (r.error ? -1 : 0), stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ?? null }
}

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

// Renaming over a file another process holds open (an editor, an antivirus scan) fails on Windows
// until it lets go: retry with backoff, and on giving up remove the temp file and rethrow.
export function replaceFile(tmp, file, { rename = fs.renameSync, attempts = 8, waitMs = 25 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      rename(tmp, file)
      return
    } catch (err) {
      if (!RETRY_CODES.has(err.code) || attempt >= attempts) {
        safeUnlink(tmp)
        throw err
      }
      sleepSync(waitMs * attempt)
    }
  }
}

function safeUnlink(file) {
  try {
    fs.unlinkSync(file)
  } catch {}
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

function parseJsonText(text, file) {
  if (text === null) return null
  try {
    return JSON.parse(text.replace(/^﻿/, ''))
  } catch (err) {
    throw new Error(`${file} is not plain JSON (${err.message}); edit it by hand or fix it first`)
  }
}

// Keep the file's own BOM, line endings, indent and final newline, so a merge shows up as added
// lines only and uninstall gives back the same bytes.
function serialize(value, original) {
  const bom = original?.startsWith('﻿') ? '﻿' : ''
  const eol = original && original.includes('\r\n') ? '\r\n' : '\n'
  const indentMatch = original ? /^([ \t]+)"/m.exec(original) : null
  const indent = indentMatch ? (indentMatch[1].startsWith('\t') ? '\t' : indentMatch[1].length) : 2
  const finalNewline = original === null || original === undefined || /\r?\n$/.test(original)
  return `${bom}${JSON.stringify(value, null, indent).replace(/\n/g, eol)}${finalNewline ? eol : ''}`
}

// Another process wrote the file between our read and our rename; the edit starts over from its bytes.
class ChangedUnderUs extends Error {}

const stateKey = (file) => (process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file))

export function makeActions({ hosts, runner = defaultRunner, now = Date.now(), skillsSrc = SKILLS_SRC, store = null }) {
  const results = []
  const record = (agent, target, status, detail = '') => results.push({ agent, target, status, detail })

  // What install created in each file (createdBy), so uninstall can remove exactly that.
  const createdIn = (file) => store?.readJson(STATE, null)?.files?.[stateKey(file)] ?? null
  function rememberCreated(file, value) {
    store?.update(STATE, { v: 1, files: {} }, (s) => {
      const files = { ...(s?.files ?? {}) }
      if (value) files[stateKey(file)] = value
      else delete files[stateKey(file)]
      return { v: 1, files }
    })
  }

  // Returns the outcome: unchanged, would create/update, created, updated.
  function writeConfig(agent, file, nextText, { dryRun, original }) {
    if (original === nextText) {
      record(agent, file, 'unchanged')
      return 'unchanged'
    }
    if (dryRun) {
      const status = original === null ? 'would create' : 'would update'
      record(agent, file, status)
      return status
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const backup = original === null ? null : `${file}.bak-agent-mods-${now}`
    if (backup) fs.writeFileSync(backup, original)
    const tmp = `${file}.tmp-agent-mods-${process.pid}`
    fs.writeFileSync(tmp, nextText)
    if (readText(file) !== original) {
      safeUnlink(tmp)
      if (backup) safeUnlink(backup)
      throw new ChangedUnderUs(`${file} changed while agent-mods was editing it`)
    }
    try {
      replaceFile(tmp, file)
    } catch (err) {
      if (backup) safeUnlink(backup)
      throw err
    }
    const status = original === null ? 'created' : 'updated'
    record(agent, file, status, backup ? `backup ${path.basename(backup)}` : '')
    return status
  }

  function editJsonOnce(agent, file, transform, opts) {
    const original = readText(file)
    const current = parseJsonText(original, file)
    const next = transform(current)
    if (next === null) {
      if (original === null) {
        record(agent, file, 'unchanged')
        return 'unchanged'
      }
      if (opts.dryRun) {
        record(agent, file, 'would delete')
        return 'would delete'
      }
      const backup = `${file}.bak-agent-mods-${now}`
      fs.writeFileSync(backup, original)
      if (readText(file) !== original) {
        safeUnlink(backup)
        throw new ChangedUnderUs(`${file} changed while agent-mods was editing it`)
      }
      fs.unlinkSync(file)
      record(agent, file, 'deleted', `backup ${path.basename(backup)}`)
      return 'deleted'
    }
    return writeConfig(agent, file, serialize(next, original), { ...opts, original })
  }

  function editJson(agent, file, transform, opts) {
    for (let attempt = 1; ; attempt++) {
      try {
        return editJsonOnce(agent, file, transform, opts)
      } catch (err) {
        if (!(err instanceof ChangedUnderUs) || attempt >= 3) throw err
      }
    }
  }

  // Install side of one hooks file: merge, then record what install created there.
  function installHooks(agent, file, specs, merge, dryRun) {
    let created = null
    const status = editJson(agent, file, (current) => {
      created = createdBy(current, specs)
      return merge(current)
    }, { dryRun })
    if (status !== 'created' && status !== 'updated') return
    const prev = createdIn(file)
    rememberCreated(file, prev ? { ...prev, events: [...new Set([...prev.events, ...created.events])] } : created)
  }

  function uninstallHooks(agent, file, unmerge, dryRun) {
    const created = createdIn(file)
    let moved = []
    const status = editJson(agent, file, (current) => {
      moved = agent === 'codex' ? hooksAfterOurs(current?.hooks) : []
      return current ? unmerge(current, created) : current
    }, { dryRun })
    if (moved.length && status !== 'would update') record(agent, file, 'note', `these hooks moved up one place; trust them again in /hooks: ${moved.join(', ')}`)
    if (!dryRun) rememberCreated(file, null)
  }

  function copySkills(agent, destRoot, { dryRun }) {
    if (!fs.existsSync(skillsSrc)) return record(agent, destRoot, 'skipped', 'no skills/ in the repo yet')
    for (const name of fs.readdirSync(skillsSrc)) {
      const src = path.join(skillsSrc, name)
      if (!fs.existsSync(path.join(src, 'SKILL.md'))) continue
      const dest = path.join(destRoot, name)
      let lst = null
      try {
        lst = fs.lstatSync(dest)
      } catch {}
      if (lst && (lst.isSymbolicLink() || !fs.existsSync(path.join(dest, SKILL_MARKER_FILE)))) {
        record(agent, dest, 'skipped', 'exists and is not ours (or is a link); not overwritten')
        continue
      }
      const want = fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8')
      const have = readText(path.join(dest, 'SKILL.md'))
      if (have === want) {
        record(agent, dest, 'unchanged')
        continue
      }
      if (dryRun) {
        record(agent, dest, have === null ? 'would create' : 'would update')
        continue
      }
      fs.mkdirSync(dest, { recursive: true })
      fs.cpSync(src, dest, { recursive: true })
      fs.writeFileSync(path.join(dest, SKILL_MARKER_FILE), 'Installed by agent-mods; removed by `agent-mods uninstall`.\n')
      record(agent, dest, have === null ? 'created' : 'updated')
    }
  }

  // Only real folders carrying our marker. A link (a junction into ~/.agents/skills) can show our
  // marker through its target, but the link itself belongs to the user.
  function removeSkills(agent, destRoot, { dryRun }) {
    if (!fs.existsSync(skillsSrc)) return
    for (const name of fs.readdirSync(skillsSrc)) {
      const dest = path.join(destRoot, name)
      let lst = null
      try {
        lst = fs.lstatSync(dest)
      } catch {}
      if (!lst || lst.isSymbolicLink() || !lst.isDirectory() || !fs.existsSync(path.join(dest, SKILL_MARKER_FILE))) continue
      if (dryRun) record(agent, dest, 'would delete')
      else {
        fs.rmSync(dest, { recursive: true, force: true })
        record(agent, dest, 'deleted')
      }
    }
  }

  // Each add or remove is checked in the exact file it should change; a CLI that wrote somewhere
  // else (another home) is a failure, not a success.
  function claudeMcp(home, { dryRun, remove }) {
    const servers = () => (parseJsonText(readText(home.configJson), home.configJson) ?? {}).mcpServers ?? {}
    const present = servers()[SERVER_NAME]
    const env = { CLAUDE_CONFIG_DIR: home.isDefault ? undefined : home.home }
    const target = `${home.configJson} mcpServers.${SERVER_NAME}`
    const output = (r) => (r.stderr || r.stdout).trim().slice(0, 300)
    if (remove) {
      if (!present) return record('claude', target, 'unchanged')
      if (dryRun) return record('claude', target, 'would remove')
      const r = runner('claude', ['mcp', 'remove', '--scope', 'user', SERVER_NAME], { env })
      if (r.code !== 0) return record('claude', target, 'failed', output(r))
      return servers()[SERVER_NAME] ? record('claude', target, 'failed', `exit 0, but the server is still in ${home.configJson}`) : record('claude', target, 'removed')
    }
    if (present && sameMcpEntry(present)) return record('claude', target, 'unchanged')
    if (dryRun) return record('claude', target, present ? 'would replace' : 'would add')
    if (present) runner('claude', ['mcp', 'remove', '--scope', 'user', SERVER_NAME], { env })
    const r = runner('claude', ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', MCP_COMMAND.command, ...MCP_COMMAND.args], { env })
    if (r.code !== 0) return record('claude', target, 'failed', output(r))
    return sameMcpEntry(servers()[SERVER_NAME]) ? record('claude', target, 'added') : record('claude', target, 'failed', `exit 0, but the server is not in ${home.configJson}`)
  }

  function codexMcp(home, { dryRun, remove }) {
    const tomlPath = path.join(home, 'config.toml')
    const hasOurs = () => {
      const text = readText(tomlPath) ?? ''
      return codexTomlHasServer(text) && text.includes(MCP_COMMAND.args[0])
    }
    const present = codexTomlHasServer(readText(tomlPath) ?? '')
    const env = { CODEX_HOME: home }
    const target = `${tomlPath} [mcp_servers.${SERVER_NAME}]`
    const output = (r) => (r.stderr || r.stdout).trim().slice(0, 300)
    if (remove) {
      if (!present) return record('codex', target, 'unchanged')
      if (dryRun) return record('codex', target, 'would remove')
      const r = runner('codex', ['mcp', 'remove', SERVER_NAME], { env })
      if (r.code !== 0) return record('codex', target, 'failed', output(r))
      return codexTomlHasServer(readText(tomlPath) ?? '') ? record('codex', target, 'failed', `exit 0, but the server is still in ${tomlPath}`) : record('codex', target, 'removed')
    }
    if (present && hasOurs()) return record('codex', target, 'unchanged')
    if (dryRun) return record('codex', target, present ? 'would replace' : 'would add')
    if (present) runner('codex', ['mcp', 'remove', SERVER_NAME], { env })
    const r = runner('codex', ['mcp', 'add', SERVER_NAME, '--env', 'AGENT_MODS_AGENT=codex', '--', MCP_COMMAND.command, ...MCP_COMMAND.args], { env })
    if (r.code !== 0) return record('codex', target, 'failed', output(r))
    return hasOurs() ? record('codex', target, 'added') : record('codex', target, 'failed', `exit 0, but the server is not in ${tomlPath}`)
  }

  // Three shims: sh for Git Bash, cmd for cmd.exe, and ps1, which PowerShell runs ahead of the .cmd in
  // the same folder. Codex and Grok run commands in PowerShell 5.1, and through the .cmd, cmd.exe would
  // re-read the arguments: an idea "R&D" ran D. The ps1 hands them to node as they are.
  function shims({ dryRun, remove }) {
    const cmdFile = path.join(hosts.binDir, 'agent-mods.cmd')
    const shFile = path.join(hosts.binDir, 'agent-mods')
    const ps1File = path.join(hosts.binDir, 'agent-mods.ps1')
    const cli = hosts.scripts.cli
    const winCli = cli.replace(/\//g, '\\')
    const cmdText = `@echo off\r\nrem agent-mods shim (installed by agent-mods)\r\nnode "${winCli}" %*\r\n`
    const shText = `#!/bin/sh\n# agent-mods shim (installed by agent-mods)\nexec node "${cli}" "$@"\n`
    const ps1Text = [
      '# agent-mods shim (installed by agent-mods)',
      `if ($MyInvocation.ExpectingInput) { $input | & node "${winCli}" @args } else { & node "${winCli}" @args }`,
      'exit $LASTEXITCODE',
      '',
    ].join('\r\n')
    for (const [file, text] of [[cmdFile, cmdText], [shFile, shText], [ps1File, ps1Text]]) {
      const have = readText(file)
      if (remove) {
        if (have === null || !have.includes('agent-mods shim')) continue
        if (dryRun) record('cli', file, 'would delete')
        else {
          fs.unlinkSync(file)
          record('cli', file, 'deleted')
        }
        continue
      }
      if (have !== null && !have.includes('agent-mods shim')) {
        record('cli', file, 'skipped', 'exists and is not ours')
        continue
      }
      writeConfig('cli', file, text, { dryRun, original: have })
    }
  }

  function removeGrokRules(home, { dryRun }) {
    const file = path.join(home, 'rules', 'agent-mods.md')
    if (readText(file) === null) return
    if (dryRun) return record('grok', file, 'would delete')
    fs.unlinkSync(file)
    record('grok', file, 'deleted')
    // The rules folder install created goes too, if nothing else is in it.
    try {
      fs.rmdirSync(path.dirname(file))
    } catch {}
  }

  function grokInspect(home) {
    if (!hosts.grokExe) return null
    const r = runner(hosts.grokExe, ['inspect', '--json'], { env: { GROK_HOME: home }, timeoutMs: 60_000 })
    if (r.code !== 0) return null
    try {
      return JSON.parse(r.stdout)
    } catch {
      return null
    }
  }

  // One failing step (a config that is not plain JSON, a CLI that is missing) must not stop the rest.
  function guard(agent, target, fn) {
    try {
      fn()
    } catch (err) {
      record(agent, target, 'failed', String(err?.message ?? err).slice(0, 300))
    }
  }

  return {
    results,
    editJson,
    install({ only, dryRun = false }) {
      const want = (agent) => !only || only.includes(agent)
      guard('cli', hosts.binDir, () => shims({ dryRun }))
      if (want('claude')) {
        guard('claude', hosts.claudeSkillsDir, () => copySkills('claude', hosts.claudeSkillsDir, { dryRun }))
        for (const home of hosts.claudeHomes) {
          const settings = path.join(home.home, 'settings.json')
          const events = claudeEventsFor(home)
          guard('claude', settings, () => installHooks('claude', settings, events, (s) => mergeClaudeSettings(s, events), dryRun))
          guard('claude', home.configJson, () => claudeMcp(home, { dryRun }))
        }
      }
      if (want('codex') || want('grok') || want('devin')) {
        guard('shared', hosts.agentsSkillsDir, () => copySkills('shared', hosts.agentsSkillsDir, { dryRun }))
      }
      if (want('codex')) {
        for (const home of hosts.codexHomes) {
          const file = path.join(home, 'hooks.json')
          guard('codex', file, () => installHooks('codex', file, CODEX_EVENTS, mergeCodexHooks, dryRun))
          guard('codex', home, () => codexMcp(home, { dryRun }))
        }
      }
      if (want('devin') && hosts.devin) {
        guard('devin', hosts.devin.mcpConfig, () =>
          editJson('devin', hosts.devin.mcpConfig, (f) => mergeMcpServers(f, { AGENT_MODS_AGENT: 'devin' }), { dryRun }),
        )
      }
      if (want('grok')) {
        for (const home of hosts.grokHomes) {
          const file = path.join(home, 'rules', 'agent-mods.md')
          guard('grok', file, () => writeConfig('grok', file, GROK_RULES, { dryRun, original: readText(file) }))
        }
      }
      return results
    },
    uninstall({ only, dryRun = false }) {
      const want = (agent) => !only || only.includes(agent)
      if (want('claude')) {
        for (const home of hosts.claudeHomes) {
          const settings = path.join(home.home, 'settings.json')
          guard('claude', settings, () => uninstallHooks('claude', settings, unmergeClaudeSettings, dryRun))
          guard('claude', home.configJson, () => claudeMcp(home, { dryRun, remove: true }))
        }
        guard('claude', hosts.claudeSkillsDir, () => removeSkills('claude', hosts.claudeSkillsDir, { dryRun }))
      }
      if (want('codex')) {
        for (const home of hosts.codexHomes) {
          const file = path.join(home, 'hooks.json')
          guard('codex', file, () => uninstallHooks('codex', file, unmergeCodexHooks, dryRun))
          guard('codex', home, () => codexMcp(home, { dryRun, remove: true }))
        }
      }
      if (want('devin') && hosts.devin) {
        guard('devin', hosts.devin.mcpConfig, () =>
          editJson('devin', hosts.devin.mcpConfig, (f) => (f ? unmergeMcpServers(f) : f), { dryRun }),
        )
      }
      if (want('grok')) {
        for (const home of hosts.grokHomes) guard('grok', path.join(home, 'rules'), () => removeGrokRules(home, { dryRun }))
      }
      // Shared pieces (the ~/.agents/skills copies and the CLI shim) serve several agents, so a
      // partial uninstall (--only) leaves them; a full uninstall removes them.
      if (!only || ['codex', 'grok', 'devin'].every(want)) {
        guard('shared', hosts.agentsSkillsDir, () => removeSkills('shared', hosts.agentsSkillsDir, { dryRun }))
      }
      if (!only) guard('cli', hosts.binDir, () => shims({ dryRun, remove: true }))
      return results
    },
    grokInspect,
  }
}

export function runInstall({ only, dryRun, uninstall = false, hostsOptions, runner, now, skillsSrc, store } = {}) {
  const hosts = discoverHosts(hostsOptions)
  const actions = makeActions({ hosts, runner, now, skillsSrc, store })
  const results = uninstall ? actions.uninstall({ only, dryRun }) : actions.install({ only, dryRun })
  return { hosts, results }
}
