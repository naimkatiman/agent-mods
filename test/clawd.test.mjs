import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Writable } from 'node:stream'
import clawd, { EVENTS_DIR, eventRel, localDate, paneScope, readPrefs, runCommand, sessionHat } from '../lib/mods/clawd.mjs'
import {
  BODY,
  COLORS,
  HATS,
  HELP,
  LEGS_STEP,
  LENS,
  LIFE,
  MOODS,
  NONE,
  PROPELLER_SPIN,
  QUIPS,
  SHADES,
  SHAPES,
  WEARABLE,
  advance,
  ansiLines,
  base,
  frame,
  halfBlocks,
  newPet,
  say,
  spawn,
  step,
  toAnsi,
  toolLine,
} from '../lib/mods/clawd-sprite.mjs'
import {
  SILENCE_MS,
  applyPrefs,
  composeRows,
  createFollower,
  createWorld,
  reduce,
  seedWorld,
  startWatch,
  textWidth,
  tickWorld,
} from '../lib/mods/clawd-watch.mjs'
import { toolKind } from '../lib/core/agents.mjs'
import { runCli } from '../lib/core/cli.mjs'
import { projectInfo } from '../lib/core/project.mjs'
import { runHook } from '../lib/core/runtime.mjs'
import { sessionKey } from '../lib/core/store.mjs'
import { SESSION_IDS, envFor, hook, makeRepo, mcpClient, payloadFor, tempStore } from './helpers.mjs'

const AGENTS = ['claude', 'codex', 'grok', 'devin']
const NOW = new Date(2026, 9, 11, 12, 0, 0).getTime()
const ORIGINAL = new URL('../claude-mods/clawd-pet/hooks/register.tsx', import.meta.url)
const HAS_ORIGINAL = fs.existsSync(ORIGINAL)
const SRC = HAS_ORIGINAL ? fs.readFileSync(ORIGINAL, 'utf8') : ''
const first = () => 0

const plain = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
const sink = () => {
  let text = ''
  const stream = new Writable({
    write(chunk, _enc, done) {
      text += chunk
      done()
    },
  })
  return { stream, text: () => text }
}
const lit = (re) => {
  const match = re.exec(SRC)
  assert.ok(match, `not found in register.tsx: ${re}`)
  return new Function(`return (${match[1]})`)()
}
// The original's template literal for a reply, filled in by expression text.
const fill = (template, values) => template.replace(/\$\{([^}]+)\}/g, (_, expr) => {
  assert.ok(expr in values, `no value for \${${expr}}`)
  return values[expr]
})
const template = (re) => {
  const match = re.exec(SRC)
  assert.ok(match, `not found in register.tsx: ${re}`)
  return match[1]
}

// ---------------------------------------------------------------- sprite (register.test.ts:7-36)

test('every hat is 12 pixels wide and fits in the three rows above the head', () => {
  for (const [name, rows] of Object.entries(HATS)) {
    assert.deepEqual({ name, ok: rows.every((r) => r.length === 12) && rows.length <= 3 }, { name, ok: true })
  }
})

test('frames encode to the raster size for every mood', () => {
  for (const mood of MOODS) {
    const p = newPet({ mood, width: 30, shades: true })
    for (let i = 0; i < 12; i++) step(p)
    const px = frame(p)
    assert.equal(px.length, 8)
    assert.ok(px.every((r) => r.length === 30))
    // The original asserted 30 x 4 cells of three 32-bit words (codepoint, fg, bg).
    const cells = halfBlocks(px)
    assert.equal(cells.length, 4)
    assert.ok(cells.every((row) => row.length === 30 && row.every((cell) => cell.length === 3)))
    const lines = ansiLines(px)
    assert.equal(lines.length, 4)
    assert.ok(lines.every((line) => plain(line).length === 30), mood)
  }
})

test('work walks, party ends back at idle, long idle naps', () => {
  const p = newPet({ tick: 0, x: 0, dir: 1, width: 40, mood: 'work', moodUntil: 0 })
  for (let i = 0; i < 10; i++) step(p)
  assert.ok(p.x > 0)

  const q = newPet({ tick: 0, mood: 'party', moodUntil: 5, lastActive: 0 })
  for (let i = 0; i < 6; i++) step(q)
  assert.equal(q.mood, 'idle')

  const r = newPet({ tick: 0, mood: 'idle', moodUntil: 0, lastActive: 0 })
  for (let i = 0; i < 3001; i++) step(r)
  assert.equal(r.mood, 'sleep')
})

test('every glyph in BODY, HATS, SHAPES and SHADES has a colour (register.tsx:53 painted R, P, Y, G, J black)', () => {
  const rows = [...BODY, LEGS_STEP, PROPELLER_SPIN, SHADES, ...Object.values(HATS).flat(), ...Object.values(SHAPES).flat()]
  const glyphs = new Set(rows.join('').replace(/\./g, ''))
  for (const glyph of glyphs) {
    assert.ok(Object.hasOwn(COLORS, glyph), `no colour for ${glyph}`)
    assert.ok(Number.isInteger(COLORS[glyph]) && COLORS[glyph] >= 0 && COLORS[glyph] <= 0xffffff, glyph)
  }
  for (const glyph of 'RPYGJ') assert.notEqual(COLORS[glyph], 0, glyph)
})

test('every frame pixel is a 24-bit colour or empty, for every hat, mood and particle', () => {
  for (const hat of WEARABLE) {
    for (const mood of MOODS) {
      const p = newPet({ hat, mood, width: 30, shades: true, x: 10 })
      for (const kind of Object.keys(SHAPES)) spawn(p, kind, 1, first)
      for (let i = 0; i < 7; i++) step(p, first)
      for (const row of frame(p)) {
        for (const c of row) assert.ok(c === NONE || (Number.isInteger(c) && c >= 0 && c <= 0xffffff), `${hat}/${mood}: ${c}`)
      }
    }
  }
  // The party hat was solid black in the original; now it is yellow and pink.
  const party = frame(newPet({ mood: 'party', partyHat: true, width: 30 })).flat()
  assert.ok(party.includes(0xffd23f) && party.includes(0xff5fa8))
})

test('sprite data, quips and help are the original text, with only the colour table repaired', { skip: !HAS_ORIGINAL }, () => {
  assert.deepEqual(QUIPS, lit(/const QUIPS = (\{[\s\S]*?\n\})\n/))
  assert.deepEqual(HATS, lit(/export const HATS: Record<string, string\[\]> = (\{[\s\S]*?\n\})\n/))
  assert.deepEqual(BODY, lit(/const BODY = (\[[\s\S]*?\n\])\n/))
  assert.equal(LEGS_STEP, lit(/const LEGS_STEP = ('[^']*')/))
  assert.equal(PROPELLER_SPIN, lit(/const PROPELLER_SPIN = ('[^']*')/))
  assert.equal(SHADES, lit(/const SHADES = ('[^']*')/))
  assert.deepEqual(LENS, lit(/const LENS = (\[[^\]]*\])/))
  assert.deepEqual(SHAPES, lit(/const SHAPES: Record<Kind, string\[\]> = (\{[\s\S]*?\n\})\n/))
  assert.deepEqual(LIFE, lit(/const LIFE: Record<Kind, number> = (\{[^}]*\})/))
  assert.equal(HELP, lit(/const HELP =\s*('[^']*')/))
  const colors = template(/const COLORS: Record<string, number> = (\{[\s\S]*?\n\})\n/)
  const broken = new Function(`return (${colors})`)()
  assert.equal(broken.R, undefined, 'the vendored original still has the swallowed keys')
  const repaired = new Function(`return (${colors.replace('dark terminal R:', 'dark terminal\nR:')})`)()
  assert.deepEqual(COLORS, repaired)
})

test('toAnsi follows cells(): space, ▄ in the bottom colour, ▀ top over bottom, reset per line', () => {
  const px = [
    [NONE, 0xff0000, NONE, 0x00ff00],
    [NONE, 0x0000ff, 0x00ff00, NONE],
  ]
  assert.deepEqual(halfBlocks(px), [[[0x20, NONE, NONE], [0x2580, 0xff0000, 0x0000ff], [0x2584, 0x00ff00, NONE], [0x2580, 0x00ff00, NONE]]])
  assert.equal(toAnsi(px), ' \x1b[48;2;0;0;255m\x1b[38;2;255;0;0m▀\x1b[49m\x1b[38;2;0;255;0m▄▀\x1b[0m')

  const out = toAnsi(frame(newPet({ width: 30, hat: 'crown' })))
  const lines = out.split('\n')
  assert.equal(lines.length, 4)
  assert.ok(lines.every((line) => line.endsWith('\x1b[0m')))
  assert.ok(out.includes('▀') && out.includes('▄'))
  assert.match(out, /\x1b\[38;2;255;196;0m/) // the crown's gold
  assert.match(out, /\x1b\[48;2;\d+;\d+;\d+m/)
})

test('spawn changes the pet it is given; base splits Windows and POSIX paths', () => {
  const a = newPet()
  const b = newPet()
  spawn(a, 'heart', 4, first)
  assert.equal(a.particles.length, 4)
  assert.equal(b.particles.length, 0)
  assert.deepEqual(a.particles.map((q) => q.age + 0), [0, -3, -6, -9])
  assert.equal(base('C:\\Users\\x\\api.ts'), 'api.ts')
  assert.equal(base('d:/repo/src/b.ts'), 'b.ts')
  assert.equal(base(undefined), '')
})

test('say throttles chatter within 12 ticks; bubbles expire, to zzz… while asleep', () => {
  const p = newPet()
  assert.equal(say(p, 'hi'), true)
  p.tick += 5
  assert.equal(say(p, '✏️  a.ts', 4, true), false)
  assert.equal(p.bubble, 'hi')
  p.tick += 7
  assert.equal(say(p, '✏️  a.ts', 4, true), true)
  assert.equal(say(p, 'oops 😅', 1), true, 'non-chatter is never throttled')
  for (let i = 0; i < 10; i++) advance(p)
  assert.equal(p.bubble, '')
  p.mood = 'sleep'
  advance(p)
  assert.equal(p.bubble, 'zzz…')
})

test('toolLine keeps the original lines; every agent tool name reaches them through toolKind', () => {
  const cases = [
    ['Edit', 'src/api.ts', '✏️  api.ts'],
    ['Write', 'C:\\x\\new.ts', '✏️  new.ts'],
    ['NotebookEdit', 'nb.ipynb', '✏️  nb.ipynb'],
    ['apply_patch', 'a.ts', '✏️  a.ts'],
    ['search_replace', 'b.ts', '✏️  b.ts'],
    ['Read', 'README.md', '👀 README.md'],
    ['Bash', 'npm test\nnpm run build', '⌨️  npm test'],
    ['Grep', null, '🔎 searching…'],
    ['Glob', null, '🔎 searching…'],
    ['WebSearch', null, '🌐 browsing…'],
    ['WebFetch', null, '🌐 browsing…'],
    ['Agent', null, '🐙 calling in a helper'],
    ['Task', null, '🐙 calling in a helper'],
    ['TodoWrite', null, '📝 making a plan'],
    ['update_plan', null, '📝 making a plan'],
    ['todo_write', null, '📝 making a plan'],
  ]
  for (const [tool, label, line] of cases) assert.equal(toolLine(toolKind(tool), label), line, tool)
  assert.equal(toolLine(toolKind('mcp__x__y'), null), null)
  assert.equal(toolLine('edit', 'a-very-long-file-name-that-goes-on-and-on.ts'), '✏️  a-very-long-file-name-that-…')
  if (HAS_ORIGINAL) {
    for (const text of ['✏️  ${', '👀 ${', '⌨️  ${', "'🔎 searching…'", "'🌐 browsing…'", "'🐙 calling in a helper'", "'📝 making a plan'"]) {
      assert.ok(SRC.includes(text), text)
    }
  }
})

// ---------------------------------------------------------------- /clawd replies

test('/clawd replies are the original strings, through the MCP tool, and each one is logged for the pane', async () => {
  const { env, store } = tempStore()
  const client = mcpClient({ mods: [clawd], env })
  await client.init()
  const say = async (verb, arg) => (await client.tool('clawd', arg === undefined ? { verb } : { verb, arg })).content[0].text
  const list = WEARABLE.join(', ')

  const status = await say('status')
  const wearing = /^Clawd is wearing the (\w+)\. /.exec(status)?.[1]
  assert.ok(WEARABLE.includes(wearing) && wearing !== 'nightcap')
  assert.equal(status, `Clawd is wearing the ${wearing}. ${HELP}`)

  assert.equal(await say('hat', 'wizard'), 'Clawd is wearing the wizard, and will keep it on. /clawd hat random goes back to a new hat each session.')
  assert.equal(readPrefs(store).hat, 'wizard')
  assert.equal(await say('status'), `Clawd is wearing the wizard. ${HELP}`)
  assert.equal(await say('hat'), 'Clawd is wearing the cowboy, and will keep it on. /clawd hat random goes back to a new hat each session.')
  assert.equal(await say('hat', 'sombrero'), `No hat called "sombrero". Hats: ${list}`)
  assert.equal(await say('hat', 'constructor'), `No hat called "constructor". Hats: ${list}`)
  assert.equal(readPrefs(store).hat, 'cowboy')
  assert.equal(await say('hats'), `Hats: ${list}. Wearing: cowboy.`)
  assert.equal(await say('pet'), 'You pet Clawd. ♥')
  assert.equal(await say('dance'), 'Clawd dances.')
  assert.equal(await say('party'), 'Party time.')
  assert.equal(await say('shades'), 'Shades on.')
  assert.equal(await say('status'), `Clawd is wearing the cowboy and shades. ${HELP}`)
  assert.equal(await say('shades'), 'Shades off.')
  assert.equal(await say('hide'), 'Clawd is hiding. /clawd show brings Clawd back.')
  assert.equal(readPrefs(store).hidden, true)
  assert.equal(await say('show'), 'Clawd is back.')
  assert.equal(readPrefs(store).hidden, false)
  assert.equal(await say('HAT', 'Viking'), 'Clawd is wearing the viking, and will keep it on. /clawd hat random goes back to a new hat each session.')

  const random = await say('hat', 'random')
  const put = /^Clawd put on the (\w+)\. A new random hat every session from now on\.$/.exec(random)?.[1]
  assert.ok(put && put !== 'viking' && put !== 'nightcap', random)
  assert.equal(readPrefs(store).hat, null)

  const result = await client.tool('clawd', { verb: 'hats' })
  assert.deepEqual(result.data.prefs, { hat: null, shades: false, hidden: false })
  client.close()

  const cmds = store.lines(eventRel(Date.now())).filter((e) => e.ev === 'clawd.cmd')
  assert.equal(cmds.length, 18)
  assert.ok(cmds.every((e) => e.v === 1 && e.sid === null && e.agent === 'claude' && typeof e.pk === 'string'))
  const of = (verb, arg) => cmds.find((e) => e.verb === verb && (arg === undefined || e.arg === arg))
  assert.equal(of('hat', 'wizard').hat, 'wizard')
  assert.equal(of('hat', 'sombrero').ok, false)
  assert.equal(of('hat', 'sombrero').hat, undefined)
  assert.equal(of('shades').shades, true)
  assert.equal(of('hide').hidden, true)
  assert.equal(of('hat', 'random').hat, put)
})

test('/clawd reply templates match register.tsx:411-462 character for character', { skip: !HAS_ORIGINAL }, () => {
  const { store } = tempStore()
  const project = projectInfo(makeRepo('shop'))
  const target = { agent: 'codex', key: sessionKey('codex', SESSION_IDS.codex) }
  const run = (input) => runCommand({ store, now: NOW, project, target, input, rand: first }).text
  const list = "WEARABLE.join(', ')"
  const values = (extra) => ({ [list]: WEARABLE.join(', '), HELP, ...extra })

  assert.equal(run('hat chef'), fill(template(/text: `(Clawd is wearing the \$\{name\}[^`]*)`/), values({ name: 'chef' })))
  assert.equal(run('hat sombrero'), fill(template(/text: `(No hat called[^`]*)`/), values({ arg: 'sombrero' })))
  assert.equal(run('hats'), fill(template(/text: `(Hats: [^`]*)`/), values({ 'pet.hat': 'chef' })))
  assert.equal(
    run('status'),
    fill(template(/return \{ text: `(Clawd is wearing the \$\{pet\.hat\}[^`]*)`/), values({ 'pet.hat': 'chef', "pet.shades ? ' and shades' : ''": '' })),
  )
  const random = run('hat random')
  assert.equal(random, fill(template(/text: `(Clawd put on the [^`]*)`/), values({ 'pet.hat': 'tophat' })))
  for (const reply of ['You pet Clawd. ♥', 'Clawd dances.', 'Party time.']) assert.ok(SRC.includes(`{ text: '${reply}' }`), reply)
  const [on, off] = /text: pet\.shades \? '([^']*)' : '([^']*)'/.exec(SRC).slice(1)
  assert.deepEqual([run('shades'), run('shades')], [on, off])
  const [hidden, back] = /text: hide \? '([^']*)' : '([^']*)'/.exec(SRC).slice(1)
  assert.deepEqual([run('hide'), run('show')], [hidden, back])
  // Bubbles the renderer shows, as the original wrote them.
  for (const text of ['`ooh, ${pet.hat}!`', '`how do I look? (${name})`', "'♪ ♫ ♪'", "'🎉 party!'", "'deal with it 😎'", "'ok, shades off'", "'thanks!'", '`hi! 👋`', "`hi! today's hat: ${pet.hat}`", "'zzz…'"]) {
    assert.ok(SRC.includes(text), text)
  }
})

test('/clawd from inside a session uses and keeps that session\'s hat', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('shop')
  await hook('claude', 'SessionStart', {}, { cwd, env, now: NOW, mods: [clawd] })
  const key = sessionKey('claude', SESSION_IDS.claude)
  const hat = sessionHat(store, key)
  assert.ok(WEARABLE.includes(hat))

  const client = mcpClient({ mods: [clawd], env: { ...env, CLAUDE_CODE_SESSION_ID: SESSION_IDS.claude } })
  await client.init()
  assert.equal((await client.tool('clawd', { verb: 'status', cwd })).content[0].text, `Clawd is wearing the ${hat}. ${HELP}`)
  await client.tool('clawd', { verb: 'hat', arg: 'chef', cwd })
  assert.equal(sessionHat(store, key), 'chef')
  const pet = await client.tool('clawd', { verb: 'pet', cwd })
  assert.equal(pet.data.session, key)
  client.close()

  const cmds = store.lines(eventRel(Date.now())).filter((e) => e.ev === 'clawd.cmd')
  assert.ok(cmds.every((e) => e.sid === key && e.agent === 'claude' && e.pk === projectInfo(cwd).projectId))
  assert.equal(cmds.at(-1).hat, 'chef', 'a targeted command tells the pane which hat that session wears')
})

test('CLI: clawd verbs print the same replies; --json gives the data', async () => {
  const { env, store } = tempStore()
  const run = async (...argv) => {
    const out = sink()
    const err = sink()
    const code = await runCli({ argv: ['clawd', ...argv], env, stdout: out.stream, stderr: err.stream, mods: [clawd] })
    return { code, out: out.text(), err: err.text() }
  }
  assert.equal((await run('hat', 'halo')).out, 'Clawd is wearing the halo, and will keep it on. /clawd hat random goes back to a new hat each session.\n')
  assert.equal((await run()).out, `Clawd is wearing the halo. ${HELP}\n`)
  assert.equal((await run('juggle')).out, `Clawd is wearing the halo. ${HELP}\n`, 'an unknown verb answers like status, as the original')
  const json = JSON.parse((await run('shades', '--json')).out)
  assert.equal(json.text, 'Shades on.')
  assert.deepEqual(json.prefs, { hat: 'halo', shades: true, hidden: false })
  assert.equal(readPrefs(store).shades, true)
})

test('CLI: clawd frame prints one ANSI frame; bad options exit 2', async () => {
  const { env } = tempStore()
  const run = async (...argv) => {
    const out = sink()
    const err = sink()
    const code = await runCli({ argv: ['clawd', 'frame', ...argv], env, stdout: out.stream, stderr: err.stream, mods: [clawd] })
    return { code, out: out.text(), err: err.text() }
  }
  const idle = await run()
  assert.equal(idle.code, 0)
  const lines = idle.out.trimEnd().split('\n')
  assert.equal(lines.length, 4)
  assert.ok(lines.every((line) => line.endsWith('\x1b[0m') && plain(line).length === 30))
  assert.ok(idle.out.includes('▀') && idle.out.includes('\x1b[38;2;'))

  const party = await run('--mood', 'party', '--hat', 'crown', '--ticks', '3')
  assert.equal(party.code, 0)
  assert.match(party.out, /\x1b\[38;2;255;196;0m/)
  assert.notEqual(party.out, (await run('--hat', 'crown')).out)
  assert.match((await run('--shades')).out, /255;43;214|176;60;255|91;77;255/)

  const badMood = await run('--mood', 'grumpy')
  assert.equal(badMood.code, 2)
  assert.match(badMood.err, /Unknown mood "grumpy"/)
  assert.equal((await run('--hat', 'sombrero')).code, 2)
  assert.equal((await run('--ticks', '-1')).code, 2)
  assert.equal((await run('--ticks', '0')).code, 0)

  const err = sink()
  const watchCode = await runCli({ argv: ['clawd', 'watch', '--project'], env, stdout: sink().stream, stderr: err.stream, mods: [clawd] })
  assert.equal(watchCode, 2)
  assert.match(err.text(), /--project takes a directory/)
})

test('watch scope: --all, --project, else this repo, else every project', () => {
  const repo = projectInfo(makeRepo('shop'))
  const loose = { ...repo, isRepo: false }
  assert.deepEqual(paneScope({ flags: {}, project: repo }), { filter: repo.projectId, scope: 'shop' })
  assert.deepEqual(paneScope({ flags: { all: true }, project: repo }), { filter: null, scope: 'all projects' })
  assert.deepEqual(paneScope({ flags: {}, project: loose }), { filter: null, scope: 'all projects' })
  assert.deepEqual(paneScope({ flags: { project: 'd:/x' }, project: loose }), { filter: loose.projectId, scope: 'shop' })
})

// ---------------------------------------------------------------- hooks

test('hooks: every agent logs its session, with no prompt text and only a file name', async () => {
  for (const agent of AGENTS) {
    const { env, store } = tempStore()
    const cwd = makeRepo('shop')
    const file = path.join(cwd, 'src', 'api.ts')
    const opts = { cwd, env, now: NOW, mods: [clawd] }
    const replies = [
      await hook(agent, 'SessionStart', {}, opts),
      await hook(agent, 'UserPromptSubmit', { prompt: 'SECRET-PROMPT deploy with token abc123' }, opts),
      await hook(agent, 'PostToolUse', { tool: 'edit', file }, opts),
      await hook(agent, 'PostToolUse', { tool: 'todo', todos: [{ text: 'step', status: 'pending' }] }, opts),
    ]
    if (agent === 'claude' || agent === 'grok') replies.push(await hook(agent, 'Notification', { message: 'needs you' }, opts))
    replies.push(await hook(agent, 'Stop', { answer: 'done' }, opts), await hook(agent, 'SessionEnd', {}, opts))
    assert.ok(replies.every((r) => r.raw === ''), `${agent}: clawd never talks to the agent`)

    const rel = eventRel(NOW)
    assert.equal(rel, `${EVENTS_DIR}/${localDate(NOW)}.jsonl`)
    const raw = fs.readFileSync(store.path(rel), 'utf8')
    assert.ok(!raw.includes('SECRET-PROMPT') && !raw.includes('abc123'), agent)
    assert.ok(raw.trimEnd().split('\n').every((line) => Buffer.byteLength(line) < 1024))
    const events = store.lines(rel)
    const expected = ['session.start', 'prompt.submit', 'tool.post', 'tool.post']
    if (agent === 'claude' || agent === 'grok') expected.push('notify')
    expected.push('turn.stop', 'session.end')
    assert.deepEqual(events.map((e) => e.ev), expected, agent)

    const key = sessionKey(agent, SESSION_IDS[agent])
    const project = projectInfo(cwd)
    for (const e of events) {
      assert.equal(e.v, 1)
      assert.equal(e.t, NOW)
      assert.equal(e.agent, agent)
      assert.equal(e.sid, key)
      assert.equal(e.pk, project.projectId)
      assert.equal(e.project, 'shop')
      assert.equal(e.prompt, undefined)
    }
    assert.equal(events[0].hat, sessionHat(store, key))
    assert.ok(WEARABLE.includes(events[0].hat) && events[0].hat !== 'nightcap')
    assert.deepEqual(
      { kind: events[2].kind, label: events[2].label, ok: events[2].ok },
      { kind: 'edit', label: 'api.ts', ok: true },
      agent,
    )
    assert.deepEqual({ kind: events[3].kind, label: events[3].label, ok: events[3].ok }, { kind: 'todo', label: undefined, ok: true }, agent)
  }
})

test('hooks: a pinned hat wins at session start; failed tools log ok false; subagents and continued turns are skipped', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('shop')
  const opts = { cwd, env, now: NOW, mods: [clawd] }
  store.writeJson('clawd.json', { hat: 'santa', shades: true })
  await hook('codex', 'SessionStart', {}, opts)
  assert.equal(sessionHat(store, sessionKey('codex', SESSION_IDS.codex)), 'santa')

  const payload = payloadFor('claude', 'PostToolUse', { tool: 'edit', file: path.join(cwd, 'src', 'a.ts') }, { cwd })
  payload.tool_response = { success: false, error: 'old_string not found' }
  await runHook({ env: envFor('claude', { cwd, base: env }), stdinText: JSON.stringify(payload), now: NOW, mods: [clawd] })

  await hook('claude', 'PostToolUse', { tool: 'edit', file: path.join(cwd, 'src', 'b.ts'), isSubagent: true }, opts)
  await hook('claude', 'UserPromptSubmit', { prompt: 'x', isSubagent: true }, opts)
  const blocker = { name: 'blocker', hooks: { Stop: (ctx) => { ctx.out.block = 'keep going' } } }
  const blocked = await hook('claude', 'Stop', {}, { ...opts, mods: [blocker, clawd] })
  assert.equal(blocked.json.decision, 'block')

  const events = store.lines(eventRel(NOW))
  assert.deepEqual(events.map((e) => e.ev), ['session.start', 'tool.post'])
  assert.deepEqual([events[1].label, events[1].ok], ['a.ts', false])
})

test('hooks: event files older than 3 days go, at most once a day', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('shop')
  const day = 24 * 3_600_000
  const name = (ms) => `${localDate(ms)}.jsonl`
  const touch = (ms) => store.append(`${EVENTS_DIR}/${name(ms)}`, { v: 1, ev: 'old' })
  for (const back of [10, 4, 3, 1]) touch(NOW - back * day)
  fs.writeFileSync(store.path(EVENTS_DIR, 'notes.txt'), 'not an event file')

  await hook('grok', 'SessionStart', {}, { cwd, env, now: NOW, mods: [clawd] })
  const left = () => fs.readdirSync(store.path(EVENTS_DIR)).sort()
  assert.deepEqual(left(), [name(NOW - 3 * day), name(NOW - day), name(NOW), 'notes.txt'].sort())
  assert.equal(readPrefs(store).lastGc, NOW)

  touch(NOW - 5 * day)
  await hook('grok', 'SessionStart', {}, { cwd, env, now: NOW + 3_600_000, mods: [clawd] })
  assert.ok(left().includes(name(NOW - 5 * day)), 'no second sweep the same day')
  await hook('grok', 'SessionStart', {}, { cwd, env, now: NOW + day, mods: [clawd] })
  assert.ok(!left().includes(name(NOW - 5 * day)))
  assert.ok(!left().includes(name(NOW - 3 * day)), 'now 4 days old')
})

// ---------------------------------------------------------------- the pane: reducer and rows

const ev = (fields) => ({ v: 1, t: NOW, agent: 'codex', sid: 'codex__s1', pk: 'shop-1', project: 'shop', ...fields })
const play = (world, events, opts = {}) => events.reduce((w, e) => reduce(w, e, { now: NOW, rand: first, ...opts }), world)
const ticks = (world, n, now = NOW) => {
  let w = world
  for (let i = 0; i < n; i++) w = tickWorld(w, { now, rand: first })
  return w
}
const petOf = (world, sid = 'codex__s1') => world.pets.find((en) => en.sid === sid)
const screen = (world, opts = {}) => composeRows(world, { columns: 80, rows: 24, ...opts }).map(plain)

test('reducer: a session gets a pet that greets, works, comments on edits and parties', () => {
  const start = createWorld({ prefs: {} })
  let world = play(start, [ev({ ev: 'session.start', hat: 'wizard' })])
  assert.equal(start.pets.length, 0, 'the reducer never changes the world it is given')
  assert.equal(petOf(world).pet.bubble, "hi! today's hat: wizard")
  assert.equal(play(createWorld({ prefs: { hat: 'wizard' } }), [ev({ ev: 'session.start', hat: 'wizard' })]).pets[0].pet.bubble, 'hi! 👋')
  assert.equal(play(world, [ev({ ev: 'session.start', hat: 'wizard' })]).pets.length, 1)

  world = play(world, [ev({ ev: 'prompt.submit' })])
  assert.equal(petOf(world).pet.mood, 'work')
  assert.equal(petOf(world).pet.bubble, QUIPS.start[0])
  world = ticks(world, 30)
  assert.equal(petOf(world).pet.bubble, '', 'the start quip lasts 3 s')

  world = play(world, [ev({ ev: 'tool.post', kind: 'edit', label: 'api.ts', ok: true })])
  assert.equal(petOf(world).pet.bubble, '✏️  api.ts')
  assert.ok(screen(world).some((line) => line.includes('‹ codex ✏️  api.ts')))
  assert.ok(screen(world).some((line) => line.trim().endsWith('shop')))
  world = play(world, [ev({ ev: 'tool.post', kind: 'todo', ok: true })])
  assert.equal(petOf(world).pet.bubble, '✏️  api.ts', 'tool chatter within 1.2 s is dropped')

  world = play(world, [ev({ ev: 'tool.post', kind: 'edit', label: 'b.ts', ok: false })])
  assert.equal(petOf(world).pet.bubble, QUIPS.oops[0])
  assert.equal(petOf(world).pet.particles.filter((q) => q.kind === 'sweat').length, 2)

  const short = play(world, [ev({ ev: 'turn.stop', t: NOW + 10_000 })])
  assert.deepEqual([petOf(short).pet.mood, petOf(short).pet.partyHat, petOf(short).pet.bubble], ['party', false, QUIPS.done[0]])
  assert.equal(petOf(short).pet.particles.filter((q) => q.kind === 'sparkle').length, 4)
  assert.equal(petOf(ticks(short, 20)).pet.mood, 'idle', 'a short turn parties for 2 s')

  const long = play(world, [ev({ ev: 'turn.stop', t: NOW + 61_000 })])
  assert.deepEqual([petOf(long).pet.partyHat, petOf(long).pet.bubble], [true, QUIPS.bigDone[0]])
  assert.equal(petOf(ticks(long, 39)).pet.mood, 'party', 'a turn over 60 s parties for 4 s')
  const after = petOf(ticks(long, 40)).pet
  assert.deepEqual([after.mood, after.partyHat], ['idle', false])
})

test('reducer: notify waits with the user, and the waiting tag lasts until the next prompt', () => {
  let world = play(createWorld(), [ev({ ev: 'session.start', hat: 'crown' }), ev({ ev: 'prompt.submit' }), ev({ ev: 'notify' })])
  const pet = petOf(world).pet
  assert.deepEqual([pet.mood, pet.bubble], ['idle', 'your call 👀'])
  assert.ok(screen(world).some((line) => line.includes('shop · waiting')))
  world = ticks(world, 301)
  assert.equal(petOf(world).pet.bubble, '', 'the bubble lasts 30 s')
  assert.ok(screen(world).some((line) => line.includes('shop · waiting')), 'the tag stays')
  world = play(world, [ev({ ev: 'prompt.submit' })])
  assert.ok(!screen(world).some((line) => line.includes('waiting')))
  assert.equal(petOf(world).pet.mood, 'work')

  // A tool finishing after a permission prompt means the agent is working again.
  world = play(world, [ev({ ev: 'notify' }), ev({ ev: 'tool.post', kind: 'edit', label: 'x.ts', ok: true })])
  assert.equal(petOf(world).waiting, false)
  assert.equal(petOf(world).pet.mood, 'work')
})

test('reducer: naps after 5 idle minutes, wakes on a prompt; pets leave on session end or 30 min of silence', () => {
  let world = play(createWorld(), [ev({ ev: 'session.start', hat: 'chef' })])
  world = ticks(world, 3001)
  assert.equal(petOf(world).pet.mood, 'sleep')
  assert.equal(petOf(world).pet.bubble, 'zzz…')
  world = ticks(world, 40)
  assert.ok(petOf(world).pet.particles.some((q) => q.kind === 'z'))
  assert.ok(frame(petOf(world).pet).flat().includes(COLORS.W), 'the nightcap is on')
  world = play(world, [ev({ ev: 'prompt.submit' })])
  assert.equal(petOf(world).pet.mood, 'work')
  assert.ok(!petOf(world).pet.particles.some((q) => q.kind === 'z'))

  const two = play(world, [ev({ sid: 'grok__s2', agent: 'grok', ev: 'prompt.submit' })])
  assert.equal(two.pets.length, 2)
  assert.equal(play(two, [ev({ ev: 'session.end' })]).pets.length, 1)
  assert.equal(tickWorld(two, { now: NOW + SILENCE_MS + 1 }).pets.length, 0)
  assert.equal(tickWorld(two, { now: NOW + SILENCE_MS - 1 }).pets.length, 2)
})

test('reducer: the first event of an unseen session creates its pet with its saved hat; other projects stay out', () => {
  const hats = { 'devin__d1': 'halo' }
  let world = createWorld({ filter: 'shop-1' })
  world = play(world, [ev({ sid: 'devin__d1', agent: 'devin', ev: 'tool.post', kind: 'todo', ok: true })], { hatOf: (sid) => hats[sid] })
  assert.equal(petOf(world, 'devin__d1').pet.hat, 'halo')
  assert.equal(petOf(world, 'devin__d1').pet.mood, 'work')
  assert.equal(petOf(world, 'devin__d1').pet.bubble, '📝 making a plan')
  world = play(world, [ev({ sid: 'claude__x', pk: 'other-2', ev: 'session.start', hat: 'tophat' })])
  assert.equal(world.pets.length, 1)
  for (const junk of [null, 'text', {}, { ev: 'prompt.submit' }, { ev: 'mystery', sid: 'a__b', pk: 'shop-1' }]) {
    assert.equal(play(world, [junk]), world)
  }
})

test('reducer: /clawd commands play on the calling session, or on every pet from outside a session', () => {
  let world = play(createWorld(), [
    ev({ ev: 'session.start', hat: 'tophat' }),
    ev({ sid: 'claude__s2', agent: 'claude', ev: 'session.start', hat: 'cowboy' }),
  ])
  world = ticks(world, 60)
  const cmd = (fields) => ev({ ev: 'clawd.cmd', sid: null, agent: null, ...fields })

  const petted = play(world, [cmd({ verb: 'pet', arg: '' })])
  assert.ok(petted.pets.every((en) => en.pet.particles.filter((q) => q.kind === 'heart').length === 4))
  assert.ok(petted.pets.every((en) => en.pet.bubble === QUIPS.pet[0]))

  const danced = play(world, [cmd({ sid: 'claude__s2', agent: 'claude', verb: 'dance', arg: '', hat: 'cowboy' })])
  assert.deepEqual(danced.pets.map((en) => en.pet.mood), ['idle', 'dance'])
  assert.equal(petOf(danced, 'claude__s2').pet.bubble, '♪ ♫ ♪')

  const partied = play(world, [cmd({ verb: 'party', arg: '' })])
  assert.ok(partied.pets.every((en) => en.pet.partyHat && en.pet.mood === 'party' && en.pet.bubble === '🎉 party!'))

  const shaded = play(world, [cmd({ sid: 'codex__s1', verb: 'shades', arg: '', shades: true, hat: 'tophat' })])
  assert.ok(shaded.pets.every((en) => en.pet.shades), 'shades are one switch for every Clawd')
  assert.deepEqual(shaded.pets.map((en) => en.pet.bubble), ['deal with it 😎', ''])
  assert.equal(play(shaded, [cmd({ verb: 'shades', arg: '', shades: false })]).pets[0].pet.bubble, 'ok, shades off')

  const hatted = play(world, [cmd({ sid: 'codex__s1', verb: 'hat', arg: 'viking', hat: 'viking' })])
  assert.deepEqual(hatted.pets.map((en) => en.pet.hat), ['viking', 'cowboy'])
  assert.equal(petOf(hatted).pet.bubble, 'how do I look? (viking)')
  assert.equal(hatted.pinned, 'viking')
  const rolled = play(hatted, [cmd({ verb: 'hat', arg: 'random', hat: 'chef' })])
  assert.deepEqual(rolled.pets.map((en) => en.pet.bubble), ['ooh, chef!', 'ooh, chef!'])
  assert.equal(rolled.pinned, null)
  const failed = play(world, [cmd({ verb: 'hat', arg: 'sombrero', ok: false })])
  assert.deepEqual(failed.pets.map((en) => en.pet.hat), ['tophat', 'cowboy'])

  const hidden = play(world, [cmd({ verb: 'hide', arg: '', hidden: true })])
  assert.deepEqual(screen(hidden), ['clawd · all projects · ctrl+c quits', 'Clawd is hiding. /clawd show brings Clawd back.'])
  assert.equal(screen(play(hidden, [cmd({ verb: 'show', arg: '', hidden: false })])).length, 9)
  assert.equal(screen(applyPrefs(world, { hidden: true })).length, 2)
  assert.ok(applyPrefs(world, { shades: true }).pets.every((en) => en.pet.shades))
})

test('seedWorld: an opened pane shows the sessions already running, not the ended or silent ones', () => {
  const at = (minutes) => NOW - minutes * 60_000
  const events = [
    ev({ sid: 'claude__old', agent: 'claude', ev: 'session.start', hat: 'halo', t: at(50) }),
    ev({ sid: 'codex__done', ev: 'session.start', hat: 'chef', t: at(20) }),
    ev({ sid: 'codex__done', ev: 'session.end', t: at(19) }),
    ev({ sid: 'grok__wait', agent: 'grok', ev: 'session.start', hat: 'crown', t: at(15) }),
    ev({ sid: 'grok__wait', agent: 'grok', ev: 'prompt.submit', t: at(14) }),
    ev({ sid: 'grok__wait', agent: 'grok', ev: 'notify', t: at(12) }),
    ev({ sid: 'devin__busy', agent: 'devin', ev: 'prompt.submit', t: at(1) }),
    ev({ sid: 'devin__busy', ev: 'clawd.cmd', verb: 'hat', arg: 'viking', hat: 'viking', t: at(1) }),
    'not an event',
  ]
  let world = seedWorld(createWorld(), events, { now: NOW, rand: first })
  assert.deepEqual(world.pets.map((en) => en.sid), ['grok__wait', 'devin__busy'])
  const [wait, busy] = world.pets
  assert.deepEqual([wait.pet.hat, wait.waiting, wait.pet.mood], ['crown', true, 'idle'])
  assert.deepEqual([busy.pet.hat, busy.waiting, busy.pet.mood, busy.pet.bubble], ['viking', false, 'work', ''])
  world = tickWorld(world, { now: NOW, rand: first })
  assert.equal(world.pets[0].pet.mood, 'sleep', 'idle for 12 minutes already')
})

test('rows: each pet is 4 rows beside its text, never wider than the pane; the most recent pets win a short pane', () => {
  const sids = ['claude__a', 'codex__b', 'grok__c', 'devin__d']
  let world = play(
    createWorld(),
    sids.map((sid, i) => ev({ sid, agent: sid.split('__')[0], ev: 'session.start', hat: 'tophat', t: NOW + i, project: 'a-project-with-a-rather-long-name' })),
  )
  world = play(world, [ev({ sid: 'codex__b', agent: 'codex', ev: 'tool.post', kind: 'edit', label: 'a-very-long-file-name-for-testing.ts', ok: true })])
  for (const columns of [40, 60, 80, 120]) {
    const lines = composeRows(tickWorld(world, { now: NOW, width: Math.max(12, Math.min(30, columns - 36)) }), { columns, rows: 40 })
    assert.equal(lines.length, 1 + 4 * 4)
    for (const line of lines) assert.ok(textWidth(plain(line)) <= columns - 1, `${columns}: ${plain(line)}`)
  }
  const short = composeRows(world, { columns: 80, rows: 10 }).map(plain)
  assert.equal(short.length, 1 + 2 * 4 + 1)
  assert.ok(short.at(-1).startsWith('+2 more'))
  assert.ok(short.some((line) => line.includes('grok')) && short.some((line) => line.includes('devin')))
  assert.ok(!short.some((line) => line.includes('claude')))
  assert.deepEqual(screen(createWorld(), { scope: 'shop' }), ['clawd · shop · ctrl+c quits', 'No sessions yet: a Clawd appears when an agent starts or does something.'])
})

test('rows: text from the log cannot move the cursor or recolour the pane', () => {
  const world = play(createWorld(), [ev({ ev: 'session.start', hat: 'tophat', agent: 'co\x1b[2Jdex', project: 'sh\u202eop\x07' })])
  const lines = composeRows(world, { columns: 80, rows: 24 })
  assert.ok(!lines.join('').includes('\x1b[2J') && !lines.join('').includes('\u202e') && !lines.join('').includes('\x07'))
  // The escape byte goes; what is left is harmless visible text.
  assert.ok(lines.map(plain).some((line) => line.includes('co[2Jdex')))
})

// ---------------------------------------------------------------- the pane: following the log

test('follower: starts at the end, reads only appended lines, skips bad ones, waits for a whole line, rolls over at midnight', () => {
  const { store } = tempStore()
  const file = store.path(eventRel(NOW))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(ev({ ev: 'session.start', hat: 'chef' }))}\n{"ev":"broken`)
  const follower = createFollower(store, NOW)
  assert.deepEqual(follower.seed().map((e) => e.ev), ['session.start'], 'history seeds pets but is not replayed')
  assert.deepEqual(follower.read(NOW), [])

  fs.appendFileSync(file, `"}\nnot json\n${JSON.stringify(ev({ ev: 'prompt.submit' }))}\n${JSON.stringify(ev({ ev: 'tool.post' })).slice(0, 20)}`)
  assert.deepEqual(follower.read(NOW).map((e) => e.ev), ['broken', 'prompt.submit'])
  fs.appendFileSync(file, `${JSON.stringify(ev({ ev: 'tool.post' })).slice(20)}\n`)
  assert.deepEqual(follower.read(NOW).map((e) => e.ev), ['tool.post'])
  assert.deepEqual(follower.read(NOW), [])

  const tomorrow = NOW + 24 * 3_600_000
  fs.appendFileSync(file, `${JSON.stringify(ev({ ev: 'turn.stop' }))}\n`)
  const next = store.path(eventRel(tomorrow))
  fs.writeFileSync(next, `${JSON.stringify(ev({ ev: 'session.end', t: tomorrow }))}\n`)
  assert.deepEqual(follower.read(tomorrow).map((e) => e.ev), ['turn.stop', 'session.end'])
  assert.equal(follower.file(), next)
})

test('watch: draws pets from appended events, hides the cursor and gives it back', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('shop')
  await hook('codex', 'SessionStart', {}, { cwd, env, now: NOW, mods: [clawd] })
  let text = ''
  const out = { columns: 80, rows: 24, write: (chunk) => { text += chunk } }
  const pane = startWatch({ store, out, clock: () => NOW, rand: first, signals: false })
  try {
    assert.ok(text.startsWith('\x1b[?25l'))
    assert.ok(plain(text).includes('codex'), 'a session already running gets its pet at once')
    await hook('codex', 'PostToolUse', { tool: 'edit', file: path.join(cwd, 'src', 'api.ts') }, { cwd, env, now: NOW, mods: [clawd] })
    const deadline = Date.now() + 3000
    while (!plain(text).includes('✏️  api.ts') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(plain(text).includes('‹ codex ✏️  api.ts'))
    assert.equal(pane.world().pets.length, 1)
  } finally {
    pane.stop()
  }
  assert.equal(await pane.done, 0)
  assert.ok(text.endsWith('\x1b[?25h\n'))
  const length = text.length
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(text.length, length, 'nothing draws after stop')
})

test('watch: ctrl+c (and Ctrl+Break, SIGTERM) stops the pane; the listeners leave with it', async () => {
  const { store } = tempStore()
  let text = ''
  const out = { columns: 80, rows: 24, write: (chunk) => { text += chunk } }
  const before = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'exit'].map((name) => process.listenerCount(name))
  const pane = startWatch({ store, out, clock: () => NOW, rand: first })
  for (const name of ['SIGINT', 'SIGTERM', 'SIGBREAK']) assert.ok(process.listeners(name).includes(pane.stop), name)
  // What process.on('SIGINT') runs on ctrl+c, called directly: emitting a real SIGINT would also
  // reach the test runner's own handler.
  process.listeners('SIGINT').find((fn) => fn === pane.stop)('SIGINT')
  assert.equal(await pane.done, 0)
  assert.ok(text.endsWith('\x1b[?25h\n'))
  assert.deepEqual(['SIGINT', 'SIGTERM', 'SIGBREAK', 'exit'].map((name) => process.listenerCount(name)), before)
  assert.ok(plain(text).includes('No sessions yet'))
})

// ---------------------------------------------------------------- skill and shape

test('skill: frontmatter, the tool, the CLI fallback, and never starting the pane', () => {
  const skill = fs.readFileSync(new URL('../skills/clawd/SKILL.md', import.meta.url), 'utf8')
  const front = /^---\n([\s\S]*?)\n---\n/.exec(skill.replace(/\r\n/g, '\n'))[1]
  assert.match(front, /^name: clawd$/m)
  const description = /^description: (.+)$/m.exec(front)[1]
  assert.ok(description.length < 1024 && !/[<>]/.test(description))
  assert.ok(skill.includes('agent-mods `clawd` tool') && skill.includes('agent-mods clawd <verb>'))
  assert.ok(skill.includes('`agent-mods clawd watch`') && /Never start it yourself/.test(skill))
})

test('mod shape: hooks, one tool, one CLI command', () => {
  assert.equal(clawd.name, 'clawd')
  assert.deepEqual(Object.keys(clawd.hooks).sort(), ['Interrupt', 'Notification', 'PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure', 'UserPromptSubmit'])
  assert.deepEqual(clawd.tools.map((t) => t.name), ['clawd'])
  assert.deepEqual(clawd.tools[0].inputSchema.required, ['verb'])
  assert.deepEqual(clawd.cli.map((c) => c.name), ['clawd'])
})

// Found while building the dashboard: frame() painted each eye one pixel to the side and then went on
// painting the body left to right, so an eye shifted right (walking right, glancing right) was painted
// over by the next body pixel. The original register.tsx:146-148 has the same order.
test('sprite: both eyes stay visible whichever way the pet looks or walks', () => {
  const eyes = (p) => frame(p).flat().filter((c) => c === COLORS.E).length
  for (const dir of [-1, 1]) {
    const walker = newPet({ width: 30, x: 10, mood: 'work', dir })
    assert.equal(eyes(walker), 2, `working, walking ${dir > 0 ? 'right' : 'left'}`)
  }
  for (const [tick, look] of [[10, 'left'], [60, 'ahead'], [110, 'right']]) {
    const idler = newPet({ width: 30, x: 10, tick })
    assert.equal(eyes(idler), 2, `idle, looking ${look}`)
  }
})
