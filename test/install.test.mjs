import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { defaultRunner, makeActions, replaceFile, runInstall } from '../lib/install/install.mjs'
import { runDoctor } from '../lib/install/doctor.mjs'
import { discoverHosts } from '../lib/install/hosts.mjs'
import { DEVIN_CLAUDE_EVENTS, claudeEventsFor, countOurHooks, mergeClaudeSettings, unmergeClaudeSettings, mergeCodexHooks, unmergeCodexHooks, withoutOurHooks } from '../lib/install/plan.mjs'
import { hookCommand } from '../lib/install/hosts.mjs'
import { tempDir, tempStore } from './helpers.mjs'

const EXISTING_HOOKS = {
  Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'powershell.exe -File "D:\\Tools\\project-hooks\\sync-context.ps1" -Trigger Stop', timeout: 180 }] }],
  PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node "C:/Users/x/.claude/hooks/shell-guard.js"', timeout: 15 }] }],
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

// A fake home laid out like this host: 2 Claude homes, 2 Codex homes, both Grok homes, Devin.
function fakeHome() {
  const home = tempDir('am-home-')
  const appData = path.join(home, 'AppData', 'Roaming')
  write(path.join(home, '.claude', 'settings.json'), `${JSON.stringify({ model: 'opus', hooks: EXISTING_HOOKS }, null, 2)}\n`)
  write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'existing-service': { command: 'existing-mcp.exe', args: [] } }, projects: {} }))
  write(path.join(home, '.agent-auth', 'homes', 'claude', 'gmail', 'settings.json'), JSON.stringify({ hooks: EXISTING_HOOKS }))
  write(path.join(home, '.agent-auth', 'homes', 'claude', 'gmail', '.claude.json'), JSON.stringify({}))
  write(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5.5"\n\n[mcp_servers.existing-service]\ncommand = "existing-mcp.exe"\n')
  write(path.join(home, '.agent-auth', 'homes', 'codex', '92', 'config.toml'), 'model = "gpt-5.5"\n')
  fs.mkdirSync(path.join(home, '.grok'), { recursive: true })
  fs.mkdirSync(path.join(home, '.grok-tui'), { recursive: true })
  write(path.join(appData, 'devin', 'mcp_config.json'), JSON.stringify({ mcpServers: { 'existing-service': { command: 'g.exe', args: [] } } }, null, 2))
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true })
  // A skill of the same name that is NOT ours must never be overwritten.
  write(path.join(home, '.claude', 'skills', 'idea', 'SKILL.md'), '---\nname: idea\ndescription: someone elses\n---\n')
  return { home, appData }
}

function fakeSkills() {
  const dir = tempDir('am-skills-')
  for (const name of ['idea', 'tracker']) write(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: test ${name}\n---\nbody\n`)
  return dir
}

// Emulates `claude mcp add/remove` and `codex mcp add/remove` against the fake home.
function fakeRunner(home) {
  const calls = []
  const runner = (cmd, args, { env = {} } = {}) => {
    calls.push({ cmd, args, env })
    if (cmd === 'claude') {
      // Like the real CLI: an unset override inherits the caller's CLAUDE_CONFIG_DIR.
      const dir = 'CLAUDE_CONFIG_DIR' in env ? env.CLAUDE_CONFIG_DIR : process.env.CLAUDE_CONFIG_DIR
      const file = dir ? path.join(dir, '.claude.json') : path.join(home, '.claude.json')
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
      cfg.mcpServers = cfg.mcpServers ?? {}
      if (args[1] === 'add') cfg.mcpServers[args[4]] = { type: 'stdio', command: args[6], args: args.slice(7), env: {} }
      if (args[1] === 'remove') delete cfg.mcpServers[args[4]]
      fs.writeFileSync(file, JSON.stringify(cfg))
      return { code: 0, stdout: '', stderr: '' }
    }
    if (cmd === 'codex') {
      const file = path.join(env.CODEX_HOME, 'config.toml')
      let text = fs.readFileSync(file, 'utf8')
      if (args[1] === 'add') text += `\n[mcp_servers.${args[2]}]\ncommand = "${args[6]}"\nargs = ["${args[7]}"]\n`
      if (args[1] === 'remove') text = text.replace(/\n\[mcp_servers\.agent-mods\][\s\S]*?(?=\n\[|$)/, '')
      fs.writeFileSync(file, text)
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 1, stdout: '', stderr: 'unexpected' }
  }
  return { runner, calls }
}

test('plan: merge keeps foreign hooks, is idempotent, and unmerge restores the original', () => {
  const settings = { model: 'opus', hooks: structuredClone(EXISTING_HOOKS) }
  const once = mergeClaudeSettings(settings)
  const twice = mergeClaudeSettings(once)
  assert.deepEqual(twice, once)
  assert.equal(countOurHooks(once.hooks), 5)
  assert.equal(once.hooks.Stop.length, 2)
  assert.equal(once.hooks.Stop[0].hooks[0].command, EXISTING_HOOKS.Stop[0].hooks[0].command)
  assert.deepEqual(unmergeClaudeSettings(once), settings)
  // A group that mixes our handler with a foreign one keeps the foreign handler.
  const mixed = { Stop: [{ matcher: '', hooks: [{ type: 'command', command: hookCommand() }, { type: 'command', command: 'other' }] }] }
  assert.deepEqual(withoutOurHooks(mixed), { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'other' }] }] })
  // No `args` array anywhere: Grok skips handlers that set it.
  assert.ok(JSON.stringify(once).includes('"command":"node ') && !JSON.stringify(once.hooks).includes('"args"'))
})

test('plan: Codex hooks file has only description + hooks, and unmerge deletes a file that was only ours', () => {
  const file = mergeCodexHooks(null)
  assert.deepEqual(Object.keys(file).sort(), ['description', 'hooks'])
  assert.equal(countOurHooks(file.hooks), 6)
  assert.match(file.hooks.SessionStart[0].hooks[0].command, /--agent codex$/)
  assert.equal(file.hooks.PostToolUse[0].matcher, '^(apply_patch|update_plan)$')
  assert.equal(file.hooks.SessionEnd[0].hooks[0].timeout, 3)
  assert.equal(unmergeCodexHooks(file), null)
})

test('install: dry run writes nothing', () => {
  const { home, appData } = fakeHome()
  const before = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')
  const { runner, calls } = fakeRunner(home)
  const { results } = runInstall({ dryRun: true, hostsOptions: { homeDir: home, appData, env: { PATH: '' } }, runner, skillsSrc: fakeSkills() })
  assert.ok(results.some((r) => r.status.startsWith('would')))
  assert.equal(calls.length, 0)
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), before)
  assert.equal(fs.existsSync(path.join(home, '.codex', 'hooks.json')), false)
})

test('install, reinstall, uninstall round trip on a fake host', () => {
  const { home, appData } = fakeHome()
  const { runner } = fakeRunner(home)
  const skillsSrc = fakeSkills()
  const opts = { hostsOptions: { homeDir: home, appData, env: { PATH: path.join(home, 'bin') } }, runner, skillsSrc, now: 1700000000000 }
  const first = runInstall(opts).results
  assert.deepEqual(first.filter((r) => r.status === 'failed'), [])

  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'))
  assert.equal(countOurHooks(settings.hooks), 5, "default home: the events Grok and Devin also accept")
  assert.equal(settings.model, 'opus')
  assert.ok(fs.existsSync(path.join(home, '.claude', 'settings.json.bak-agent-mods-1700000000000')))
  const gmail = JSON.parse(fs.readFileSync(path.join(home, '.agent-auth', 'homes', 'claude', 'gmail', 'settings.json'), 'utf8'))
  assert.equal(countOurHooks(gmail.hooks), 7, "alternate home: plus Notification and StopFailure")
  assert.ok(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).mcpServers['agent-mods'])
  assert.ok(JSON.parse(fs.readFileSync(path.join(home, '.agent-auth', 'homes', 'claude', 'gmail', '.claude.json'), 'utf8')).mcpServers['agent-mods'])
  for (const codexHome of [path.join(home, '.codex'), path.join(home, '.agent-auth', 'homes', 'codex', '92')]) {
    assert.equal(countOurHooks(JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8')).hooks), 6)
    assert.match(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'), /\[mcp_servers\.agent-mods\]/)
  }
  const devin = JSON.parse(fs.readFileSync(path.join(appData, 'devin', 'mcp_config.json'), 'utf8'))
  assert.ok(devin.mcpServers['existing-service'] && devin.mcpServers['agent-mods'])
  assert.ok(fs.existsSync(path.join(home, '.grok', 'rules', 'agent-mods.md')))
  assert.ok(fs.existsSync(path.join(home, '.grok-tui', 'rules', 'agent-mods.md')))
  assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'idea', 'SKILL.md')))
  // The foreign 'idea' skill in ~/.claude/skills survived; 'tracker' was added.
  assert.match(fs.readFileSync(path.join(home, '.claude', 'skills', 'idea', 'SKILL.md'), 'utf8'), /someone elses/)
  assert.ok(first.some((r) => r.status === 'skipped' && r.target.endsWith(path.join('skills', 'idea'))))
  assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'tracker', 'SKILL.md')))
  assert.ok(fs.existsSync(path.join(home, 'bin', 'agent-mods.cmd')))

  const second = runInstall(opts).results
  assert.deepEqual(second.filter((r) => !['unchanged', 'skipped'].includes(r.status)), [])

  const doctor = runDoctor({ hostsOptions: opts.hostsOptions })
  const failing = doctor.checks.filter((k) => !k.ok && k.agent !== 'note')
  // Only the Codex trust step (a /hooks click the user makes) and the foreign 'idea' skill remain.
  assert.ok(failing.every((k) => /trusted|skills in/.test(k.item)), JSON.stringify(failing, null, 2))

  const removed = runInstall({ ...opts, uninstall: true }).results
  assert.deepEqual(removed.filter((r) => r.status === 'failed'), [])
  const after = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'))
  assert.deepEqual(after.hooks, EXISTING_HOOKS)
  assert.equal(fs.existsSync(path.join(home, '.codex', 'hooks.json')), false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).mcpServers['agent-mods'], undefined)
  assert.doesNotMatch(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), /agent-mods/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(appData, 'devin', 'mcp_config.json'), 'utf8')).mcpServers['agent-mods'], undefined)
  assert.equal(fs.existsSync(path.join(home, '.grok', 'rules', 'agent-mods.md')), false)
  assert.equal(fs.existsSync(path.join(home, '.agents', 'skills', 'idea')), false)
  assert.match(fs.readFileSync(path.join(home, '.claude', 'skills', 'idea', 'SKILL.md'), 'utf8'), /someone elses/)
  assert.equal(fs.existsSync(path.join(home, 'bin', 'agent-mods.cmd')), false)
})

test('install: a config that is not plain JSON fails alone; the rest still installs', () => {
  const { home, appData } = fakeHome()
  write(path.join(appData, 'devin', 'mcp_config.json'), '{\n  // comment\n  "mcpServers": {}\n}\n')
  const { runner } = fakeRunner(home)
  const { results } = runInstall({ hostsOptions: { homeDir: home, appData, env: {} }, runner, skillsSrc: fakeSkills() })
  const failed = results.filter((r) => r.status === 'failed')
  assert.equal(failed.length, 1)
  assert.equal(failed[0].agent, 'devin')
  assert.equal(countOurHooks(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).hooks), 5)
})

const read = (file) => fs.readFileSync(file, 'utf8')
const hostOpts = (home, appData) => ({ homeDir: home, appData, env: { PATH: path.join(home, 'bin') } })

test('plan: reinstall replaces ours in place, so nothing moves and nothing is rewritten', () => {
  const settings = { hooks: { Stop: structuredClone(EXISTING_HOOKS.Stop), PostToolUse: [], PreToolUse: structuredClone(EXISTING_HOOKS.PreToolUse) } }
  const once = mergeClaudeSettings(settings)
  assert.equal(JSON.stringify(mergeClaudeSettings(once)), JSON.stringify(once), 'same keys, same order')
  assert.deepEqual(Object.keys(once.hooks).slice(0, 3), ['Stop', 'PostToolUse', 'PreToolUse'])
  // A user hook added after ours keeps its group index, which is its Codex trust key.
  const codex = mergeCodexHooks(null)
  codex.hooks.Stop.push({ hooks: [{ type: 'command', command: 'node C:/mine/stop.js', timeout: 5 }] })
  assert.equal(JSON.stringify(mergeCodexHooks(codex)), JSON.stringify(codex))
  // A stale command of ours (the checkout moved) is replaced where it stands.
  const stale = structuredClone(codex)
  stale.hooks.Stop[0].hooks[0].command = 'node C:/old/place/bin/agent-mods-hook.mjs --agent codex'
  assert.equal(JSON.stringify(mergeCodexHooks(stale)), JSON.stringify(codex))
})

test('plan: our hooks are found by the entry script name, whatever the checkout folder is called', () => {
  for (const command of ['node D:/work/agent-mods-main/bin/agent-mods-hook.mjs', 'node "C:\\x y\\wt\\bin\\agent-mods-hook.mjs" --agent codex']) {
    assert.equal(countOurHooks({ Stop: [{ hooks: [{ type: 'command', command }] }] }), 1, command)
  }
  assert.equal(countOurHooks({ Stop: [{ hooks: [{ type: 'command', command: 'node C:/plugins/x/bin/hook.mjs' }] }] }), 0)
})

test('install then uninstall gives back the exact settings file, including an empty event the user had', () => {
  const { home, appData } = fakeHome()
  const file = path.join(home, '.claude', 'settings.json')
  const original = { model: 'opus', hooks: { Stop: EXISTING_HOOKS.Stop, PostToolUse: [], PreToolUse: EXISTING_HOOKS.PreToolUse } }
  write(file, `${JSON.stringify(original, null, 2)}\n`)
  const before = read(file)
  const { store } = tempStore()
  const opts = { hostsOptions: hostOpts(home, appData), runner: fakeRunner(home).runner, skillsSrc: fakeSkills(), store, now: 1 }
  runInstall(opts)
  const second = runInstall({ ...opts, now: 2 }).results
  assert.deepEqual(second.filter((r) => r.target === file).map((r) => r.status), ['unchanged'], 'a second install rewrites nothing')
  runInstall({ ...opts, uninstall: true, now: 3 })
  assert.equal(read(file), before)
})

test('install: the default Claude home never inherits CLAUDE_CONFIG_DIR from the shell that runs install', () => {
  const { home, appData } = fakeHome()
  const alt = path.join(home, '.agent-auth', 'homes', 'claude', 'gmail')
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = alt
  try {
    const { results } = runInstall({ hostsOptions: hostOpts(home, appData), runner: fakeRunner(home).runner, skillsSrc: fakeSkills(), store: tempStore().store })
    assert.ok(JSON.parse(read(path.join(home, '.claude.json'))).mcpServers['agent-mods'], 'the default home got the server')
    assert.deepEqual(results.filter((r) => r.status === 'failed'), [])
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
  }
})

test('install: an MCP add that lands in the wrong file is reported failed, not added', () => {
  const { home, appData } = fakeHome()
  const alt = path.join(home, '.agent-auth', 'homes', 'claude', 'gmail', '.claude.json')
  const misplaced = (cmd) => {
    const cfg = JSON.parse(read(alt))
    cfg.mcpServers = { ...cfg.mcpServers, 'agent-mods': { command: 'node' } }
    fs.writeFileSync(alt, JSON.stringify(cfg))
    return { code: cmd === 'claude' ? 0 : 1, stdout: '', stderr: '' }
  }
  const { results } = runInstall({ only: ['claude'], hostsOptions: hostOpts(home, appData), runner: misplaced, skillsSrc: fakeSkills(), store: tempStore().store })
  const mine = results.find((r) => r.target.startsWith(path.join(home, '.claude.json')))
  assert.equal(mine.status, 'failed')
  assert.match(mine.detail, /not in/)
})

test('defaultRunner: an undefined override removes an inherited variable from the child', () => {
  process.env.AGENT_MODS_TEST_LEAK = 'leaked'
  try {
    const r = defaultRunner(process.execPath, ['-e', 'process.stdout.write(String(process.env.AGENT_MODS_TEST_LEAK))'], { env: { AGENT_MODS_TEST_LEAK: undefined } })
    assert.equal(r.stdout, 'undefined')
  } finally {
    delete process.env.AGENT_MODS_TEST_LEAK
  }
})

test('install keeps a BOM, leaves a user Codex hooks.json without our description, and uninstall restores both', () => {
  const { home, appData } = fakeHome()
  const settings = path.join(home, '.claude', 'settings.json')
  write(settings, `\ufeff${JSON.stringify({ hooks: EXISTING_HOOKS }, null, 2)}\n`)
  const codexFile = path.join(home, '.codex', 'hooks.json')
  const userCodex = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node C:/mine/stop.js', timeout: 5 }] }] } }, null, 2)}\n`
  write(codexFile, userCodex)
  const before = read(settings)
  const opts = { hostsOptions: hostOpts(home, appData), runner: fakeRunner(home).runner, skillsSrc: fakeSkills(), store: tempStore().store, now: 1 }
  runInstall(opts)
  assert.ok(read(settings).startsWith('\ufeff'), 'BOM kept')
  assert.equal(JSON.parse(read(codexFile)).description, undefined)
  assert.equal(JSON.parse(read(codexFile)).hooks.Stop[0].hooks[0].command, 'node C:/mine/stop.js', 'the user hook keeps index 0')
  runInstall({ ...opts, uninstall: true, now: 2 })
  assert.equal(read(settings), before)
  assert.equal(read(codexFile), userCodex)
  assert.equal(fs.existsSync(path.join(home, '.grok', 'rules')), false, 'the rules folder install created is gone')
})

test('uninstall leaves a skills junction the user owns, even when it resolves to our copy', { skip: process.platform !== 'win32' }, () => {
  const { home, appData } = fakeHome()
  const shared = path.join(home, '.agents', 'skills')
  fs.mkdirSync(shared, { recursive: true })
  const link = path.join(home, '.claude', 'skills', 'tracker')
  fs.symlinkSync(path.join(shared, 'tracker'), link, 'junction')
  const opts = { hostsOptions: hostOpts(home, appData), runner: fakeRunner(home).runner, skillsSrc: fakeSkills(), store: tempStore().store }
  runInstall(opts)
  runInstall({ ...opts, uninstall: true })
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the junction is still there')
})

test('install: a settings write by another process during ours is merged, not lost', () => {
  const { home, appData } = fakeHome()
  const file = path.join(home, '.claude', 'settings.json')
  const actions = makeActions({ hosts: discoverHosts(hostOpts(home, appData)), runner: fakeRunner(home).runner, skillsSrc: fakeSkills(), now: 1 })
  let raced = false
  actions.editJson('claude', file, (s) => {
    if (!raced) {
      raced = true
      fs.writeFileSync(file, JSON.stringify({ ...s, theme: 'set-by-another-process' }))
    }
    return mergeClaudeSettings(s)
  }, { dryRun: false })
  const after = JSON.parse(read(file))
  assert.equal(after.theme, 'set-by-another-process')
  assert.equal(countOurHooks(after.hooks), 5)
})

test('replaceFile: retries a locked rename, and on giving up leaves no temp file behind', () => {
  const dir = tempDir('am-rename-')
  const file = path.join(dir, 'settings.json')
  const tmp = `${file}.tmp`
  fs.writeFileSync(file, 'old')
  fs.writeFileSync(tmp, 'new')
  let calls = 0
  const flaky = (a, b) => {
    if (++calls < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' })
    fs.renameSync(a, b)
  }
  replaceFile(tmp, file, { rename: flaky, waitMs: 1 })
  assert.equal(read(file), 'new')
  fs.writeFileSync(tmp, 'newer')
  const locked = () => {
    throw Object.assign(new Error('locked'), { code: 'EBUSY' })
  }
  assert.throws(() => replaceFile(tmp, file, { rename: locked, waitMs: 1 }), /locked/)
  assert.equal(fs.existsSync(tmp), false)
  assert.equal(read(file), 'new')
})

test('plan: the default settings.json only gets events Devin Local accepts, or Devin drops every hook in it', () => {
  const defaultHome = claudeEventsFor({ isDefault: true }).map((s) => s.event)
  for (const event of defaultHome) assert.ok(DEVIN_CLAUDE_EVENTS.has(event), `${event} would make Devin reject ~/.claude/settings.json`)
  const merged = mergeClaudeSettings({ hooks: EXISTING_HOOKS }, claudeEventsFor({ isDefault: true }))
  for (const event of Object.keys(merged.hooks)) assert.ok(DEVIN_CLAUDE_EVENTS.has(event), event)
  // Alternate homes are read by Claude Code alone, so they also get the Claude-only events.
  const alt = claudeEventsFor({ isDefault: false }).map((s) => s.event)
  assert.ok(alt.includes('Notification') && alt.includes('StopFailure'))
  // A reinstall moves an older install's Notification hook out of the default home.
  const older = { hooks: { ...structuredClone(EXISTING_HOOKS), Notification: [{ matcher: '', hooks: [{ type: 'command', command: 'node D:/x/bin/agent-mods-hook.mjs', timeout: 10 }] }] } }
  assert.equal(mergeClaudeSettings(older).hooks.Notification, undefined)
})
