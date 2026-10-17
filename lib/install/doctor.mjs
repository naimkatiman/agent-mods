// Read-only health check: is every agent home wired, and has each agent's hook actually fired?
// `--deep` also asks Grok what it loads (grok inspect --json per home), the only proof that its Claude
// compat import picked up our hooks, MCP server, skills and rules.
import fs from 'node:fs'
import path from 'node:path'
import { MARKER, SERVER_NAME, SKILL_MARKER_FILE, discoverHosts } from './hosts.mjs'
import { CODEX_EVENTS, claudeEventsFor, codexTomlHasServer, countOurHooks, sameMcpEntry } from './plan.mjs'
import { SKILLS_SRC, defaultRunner } from './install.mjs'
import { listRecords } from '../core/session-records.mjs'
import { agentLabel, agoText, sanitize } from '../core/text.mjs'

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
  } catch {
    return null
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function skillNames() {
  try {
    return fs.readdirSync(SKILLS_SRC).filter((n) => fs.existsSync(path.join(SKILLS_SRC, n, 'SKILL.md')))
  } catch {
    return []
  }
}

function countDangling(dir) {
  let n = 0
  try {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      try {
        if (fs.lstatSync(full).isSymbolicLink() && !fs.existsSync(full)) n++
      } catch {}
    }
  } catch {}
  return n
}

export function runDoctor({ store, deep = false, runner = defaultRunner, hostsOptions, now = Date.now() } = {}) {
  const hosts = discoverHosts(hostsOptions)
  const checks = []
  const add = (agent, item, ok, detail = '') => checks.push({ agent, item, ok, detail })
  const skills = skillNames()

  const major = Number(process.versions.node.split('.')[0])
  add('core', 'node >= 22', major >= 22, process.versions.node)
  add('core', 'code path has no spaces', !/\s/.test(hosts.scripts.hook), hosts.scripts.hook)
  add('cli', 'agent-mods shim on PATH', fs.existsSync(path.join(hosts.binDir, 'agent-mods.cmd')) && hosts.pathHasBin, hosts.binDir)

  for (const home of hosts.claudeHomes) {
    const settings = readJson(path.join(home.home, 'settings.json'))
    const n = countOurHooks(settings?.hooks)
    const want = claudeEventsFor(home).length
    add('claude', `hooks in ${home.home}`, n === want, `${n}/${want}`)
    const cfg = readJson(home.configJson)
    add('claude', `MCP in ${home.configJson}`, sameMcpEntry(cfg?.mcpServers?.[SERVER_NAME]), cfg ? '' : 'file missing or unreadable')
  }
  const claudeSkills = skills.filter((s) => fs.existsSync(path.join(hosts.claudeSkillsDir, s, SKILL_MARKER_FILE)))
  add('claude', `skills in ${hosts.claudeSkillsDir}`, claudeSkills.length === skills.length, `${claudeSkills.length}/${skills.length}`)

  const sharedSkills = skills.filter((s) => fs.existsSync(path.join(hosts.agentsSkillsDir, s, SKILL_MARKER_FILE)))
  add('shared', `skills in ${hosts.agentsSkillsDir} (Codex, Grok, Devin)`, sharedSkills.length === skills.length, `${sharedSkills.length}/${skills.length}`)

  for (const home of hosts.codexHomes) {
    const hooksFile = readJson(path.join(home, 'hooks.json'))
    const n = countOurHooks(hooksFile?.hooks)
    add('codex', `hooks in ${home}`, n === CODEX_EVENTS.length, `${n}/${CODEX_EVENTS.length}`)
    const toml = readText(path.join(home, 'config.toml'))
    add('codex', `MCP in ${home}\\config.toml`, codexTomlHasServer(toml))
  }

  if (hosts.devin) {
    const cfg = readJson(hosts.devin.mcpConfig)
    add('devin', `MCP in ${hosts.devin.mcpConfig}`, sameMcpEntry(cfg?.mcpServers?.[SERVER_NAME]), 'Devin Local also imports ~/.claude.json and ~/.claude/settings.json')
  }

  for (const home of hosts.grokHomes) {
    add('grok', `rules file in ${home}`, fs.existsSync(path.join(home, 'rules', 'agent-mods.md')))
    if (!deep || !hosts.grokExe) continue
    const r = runner(hosts.grokExe, ['inspect', '--json'], { env: { GROK_HOME: home }, timeoutMs: 60_000 })
    let info = null
    try {
      info = JSON.parse(r.stdout)
    } catch {}
    if (!info) {
      add('grok', `grok inspect (${home})`, false, (r.stderr || 'no JSON').slice(0, 200))
      continue
    }
    const hooks = (info.hooks ?? []).filter((h) => String(h.target ?? '').replace(/\\/g, '/').includes(MARKER))
    const events = new Set(hooks.map((h) => h.event))
    add('grok', `hooks loaded (${home})`, events.size >= 5, [...events].join(', ') || 'none')
    const mcp = (info.mcpServers ?? []).find((m) => m.name === SERVER_NAME)
    add('grok', `MCP loaded (${home})`, Boolean(mcp), mcp ? `source ${mcp.source?.type}` : 'missing')
    const loadedSkills = (info.skills ?? []).filter((s) => skills.includes(s.name) && !s.disabled)
    add('grok', `skills loaded (${home})`, loadedSkills.length === skills.length, `${loadedSkills.length}/${skills.length}`)
    const rules = (info.projectInstructions ?? []).some((p) => /agent-mods\.md$/i.test(String(p.path)))
    add('grok', `rules loaded (${home})`, rules)
  }

  // Proof of life: the newest session record each agent's hooks wrote.
  if (store) {
    const newest = {}
    for (const r of listRecords(store)) {
      if (!newest[r.agent] || (r.beatAt ?? 0) > newest[r.agent].beatAt) newest[r.agent] = r
    }
    for (const agent of ['claude', 'codex', 'grok', 'devin']) {
      const r = newest[agent]
      add(agent, 'hook activity seen', Boolean(r), r ? `${agentLabel(agent)} ${agoText(r.beatAt, now)} in ${sanitize(r.cwd, 300)}` : 'no session has run a hook yet')
    }
    const errors = readText(store.path('logs', 'errors.log'))
    const lines = errors ? errors.trim().split('\n') : []
    add('core', 'hook/MCP errors logged', lines.length === 0, lines.length ? `${lines.length} lines; last: ${lines.at(-1).slice(0, 160)}` : '')
  }

  const dangling = [hosts.claudeSkillsDir, ...hosts.grokHomes.map((h) => path.join(h, 'skills'))]
    .map((dir) => [dir, countDangling(dir)])
    .filter(([, n]) => n > 0)
  for (const [dir, n] of dangling) add('note', `dangling skill links in ${dir}`, true, `${n} (pre-existing, not touched by agent-mods)`)

  return { hosts, checks }
}
