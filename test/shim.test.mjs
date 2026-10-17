// The CLI shim must pass free text through PowerShell 5.1 (the Codex and Grok shell here) unchanged.
// agent-mods.cmd cannot: cmd.exe re-reads %* and runs whatever follows an & outside its quotes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { runInstall } from '../lib/install/install.mjs'
import { makeRepo, tempDir, tempStore } from './helpers.mjs'

function fakeHomeWithBin() {
  const home = tempDir('am-shim-home-')
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true })
  return { home, appData: path.join(home, 'AppData', 'Roaming') }
}

test('install writes a PowerShell shim beside the cmd and sh ones, and uninstall removes it', () => {
  const { home, appData } = fakeHomeWithBin()
  const opts = { hostsOptions: { homeDir: home, appData, env: { PATH: path.join(home, 'bin') } }, runner: () => ({ code: 0, stdout: '', stderr: '' }), skillsSrc: tempDir('am-noskills-'), store: tempStore().store }
  runInstall({ ...opts, only: ['grok'] })
  const ps1 = path.join(home, 'bin', 'agent-mods.ps1')
  const text = fs.readFileSync(ps1, 'utf8')
  assert.match(text, /agent-mods shim/)
  assert.match(text, /@args/)
  runInstall({ ...opts, uninstall: true })
  assert.equal(fs.existsSync(ps1), false)
})

test('PowerShell resolves agent-mods to the .ps1 shim, so an & in free text stays text', { skip: process.platform !== 'win32' }, () => {
  const { home, appData } = fakeHomeWithBin()
  const bin = path.join(home, 'bin')
  runInstall({ hostsOptions: { homeDir: home, appData, env: { PATH: bin } }, runner: () => ({ code: 0, stdout: '', stderr: '' }), skillsSrc: tempDir('am-noskills-'), store: tempStore().store, only: ['grok'] })
  const { root } = tempStore()
  const repo = makeRepo('shim')
  const marker = path.join(tempDir('am-marker-'), 'PWNED.txt')
  const ps = (arg) => `$env:Path = '${bin};' + $env:Path; agent-mods idea add ${arg} --cwd '${repo}'`
  const pwsh = (arg) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps(arg)], { env: { ...process.env, AGENT_MODS_HOME: root }, encoding: 'utf8', timeout: 60_000 })
  // PowerShell passes a word without spaces unquoted; cmd.exe would run "D" and keep "R".
  pwsh("'R&D'")
  // PowerShell 5.1 does not escape embedded double quotes; cmd.exe would run the echo.
  pwsh(`'Fix "npm ci & echo x> ${marker}" later'`)
  assert.equal(fs.existsSync(marker), false, 'nothing after an & ran as a command')
  const shelf = JSON.parse(fs.readFileSync(path.join(root, 'projects', fs.readdirSync(path.join(root, 'projects'))[0], 'ideas.json'), 'utf8'))
  assert.ok((shelf.ideas ?? shelf.items ?? []).some((idea) => idea.text === 'R&D'), JSON.stringify(shelf))
})
