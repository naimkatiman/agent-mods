// The Clawd world as the dashboard page loads it: lib/mods/clawd-world.mjs imported directly, with a
// fixed clock and rand = () => 0. test/clawd.test.mjs drives the same functions through clawd-watch.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { QUIPS, TICK_MS, randomHat } from '../lib/mods/clawd-sprite.mjs'
import * as pane from '../lib/mods/clawd-watch.mjs'
import { BIG_TURN_MS, SILENCE_MS, applyPrefs, createWorld, reduce, seedWorld, tickWorld } from '../lib/mods/clawd-world.mjs'

const NOW = new Date(2026, 9, 12, 12, 0, 0).getTime()
const first = () => 0
const minutesAgo = (minutes) => NOW - minutes * 60_000
const ev = (fields) => ({ v: 1, t: NOW, agent: 'codex', sid: 'codex__s1', pk: 'shop-1', project: 'shop', ...fields })
const play = (world, events, opts = {}) => events.reduce((w, e) => reduce(w, e, { now: NOW, rand: first, ...opts }), world)
const petOf = (world, sid = 'codex__s1') => world.pets.find((en) => en.sid === sid)

const source = (name) => fs.readFileSync(new URL(`../lib/mods/${name}`, import.meta.url), 'utf8')
// Every module a file loads: static imports, re-exports and bare `import '...'` lines.
const specifiers = (src) => [...src.matchAll(/\bfrom\s*(['"])(.*?)\1|\bimport\s*(['"])(.*?)\3/g)].map((m) => m[2] ?? m[4])
const HOST_ONLY = ['node:', 'process.', 'Buffer', 'require(']

test('clawd-world.mjs loads in a browser as is: its only import is the sprite, and the sprite imports nothing', () => {
  const world = source('clawd-world.mjs')
  assert.deepEqual([...new Set(specifiers(world))], ['./clawd-sprite.mjs'])
  assert.ok(!/\bimport\s*\(/.test(world), 'no dynamic import')
  for (const token of HOST_ONLY) assert.ok(!world.includes(token), `clawd-world.mjs contains ${token}`)
  // The page fetches the sprite beside it, so the sprite must stay browser-safe too.
  const sprite = source('clawd-sprite.mjs')
  assert.deepEqual(specifiers(sprite), [])
  assert.ok(!/\bimport\s*\(/.test(sprite), 'no dynamic import in the sprite')
  for (const token of HOST_ONLY) assert.ok(!sprite.includes(token), `clawd-sprite.mjs contains ${token}`)
})

test('seedWorld: pets for the sessions active in the last 30 minutes, without replaying their animations', () => {
  const events = [
    ev({ sid: 'claude__quiet', agent: 'claude', ev: 'session.start', hat: 'halo', t: minutesAgo(31) }),
    ev({ sid: 'codex__gone', ev: 'session.start', hat: 'chef', t: minutesAgo(20) }),
    ev({ sid: 'codex__gone', ev: 'session.end', t: minutesAgo(19) }),
    ev({ sid: 'grok__ask', agent: 'grok', ev: 'session.start', hat: 'crown', t: minutesAgo(15) }),
    ev({ sid: 'grok__ask', agent: 'grok', ev: 'notify', t: minutesAgo(12) }),
    ev({ sid: 'devin__busy', agent: 'devin', ev: 'session.start', hat: 'viking', t: minutesAgo(3) }),
    ev({ sid: 'devin__busy', agent: 'devin', ev: 'prompt.submit', t: minutesAgo(2) }),
    'not an event',
  ]
  const seeded = seedWorld(createWorld(), events, { now: NOW, rand: first })
  assert.deepEqual(seeded.pets.map((en) => en.sid), ['grok__ask', 'devin__busy'], 'not the ended session, not the one silent for 31 minutes')
  const [ask, busy] = seeded.pets
  assert.deepEqual([ask.agent, ask.pet.hat, ask.pet.mood, ask.waiting, ask.seenAt], ['grok', 'crown', 'idle', true, minutesAgo(12)])
  assert.deepEqual([busy.agent, busy.pet.hat, busy.pet.mood, busy.waiting, busy.promptAt], ['devin', 'viking', 'work', false, minutesAgo(2)])
  assert.ok(seeded.pets.every((en) => en.pet.bubble === ''), 'no greeting is replayed')
  assert.equal(ask.pet.lastActive, -Math.round((NOW - minutesAgo(12)) / TICK_MS), 'the nap clock is backdated')
  assert.equal(tickWorld(seeded, { now: NOW, rand: first }).pets[0].pet.mood, 'sleep', 'silent for 12 minutes: already asleep')
  assert.equal(seedWorld(createWorld({ filter: 'other-2' }), events, { now: NOW, rand: first }).pets.length, 0, 'another project stays out')
})

test('reduce: a prompt sets the pet to work, and the end of the turn throws a party', () => {
  const started = play(createWorld(), [ev({ ev: 'session.start', hat: 'wizard' })])
  const working = play(started, [ev({ ev: 'prompt.submit' })])
  assert.deepEqual([petOf(working).pet.mood, petOf(working).pet.bubble, petOf(working).promptAt], ['work', QUIPS.start[0], NOW])
  assert.equal(petOf(started).pet.mood, 'idle', 'the world it was given is unchanged')

  const done = petOf(play(working, [ev({ ev: 'turn.stop', t: NOW + 10_000 })])).pet
  assert.deepEqual([done.mood, done.moodUntil - done.tick, done.partyHat, done.bubble], ['party', 20, false, QUIPS.done[0]])
  assert.equal(done.particles.filter((q) => q.kind === 'sparkle').length, 4)

  const big = petOf(play(working, [ev({ ev: 'turn.stop', t: NOW + BIG_TURN_MS + 1 })])).pet
  assert.deepEqual([big.mood, big.moodUntil - big.tick, big.partyHat, big.bubble], ['party', 40, true, QUIPS.bigDone[0]])
})

test('reduce: notify leaves the pet waiting on you with "your call", until the next prompt', () => {
  let world = play(createWorld(), [ev({ ev: 'session.start', hat: 'crown' }), ev({ ev: 'prompt.submit' }), ev({ ev: 'notify' })])
  const asked = petOf(world)
  assert.deepEqual([asked.waiting, asked.pet.mood, asked.pet.bubble], [true, 'idle', 'your call 👀'])
  assert.equal(asked.pet.bubbleUntil - asked.pet.tick, 300, 'the bubble stays 30 s')
  world = play(world, [ev({ ev: 'prompt.submit' })])
  assert.deepEqual([petOf(world).waiting, petOf(world).pet.mood], [false, 'work'])
})

test('pets leave: session.end removes one, tickWorld drops one after 30 minutes of silence', () => {
  const two = play(createWorld(), [ev({ ev: 'prompt.submit' }), ev({ sid: 'grok__s2', agent: 'grok', ev: 'prompt.submit', t: NOW + 60_000 })])
  assert.deepEqual(two.pets.map((en) => en.sid), ['codex__s1', 'grok__s2'])
  assert.deepEqual(play(two, [ev({ ev: 'session.end' })]).pets.map((en) => en.sid), ['grok__s2'])

  assert.equal(SILENCE_MS, 30 * 60_000)
  const kept = tickWorld(two, { now: NOW + SILENCE_MS, rand: first })
  assert.deepEqual(kept.pets.map((en) => en.sid), ['codex__s1', 'grok__s2'], 'exactly 30 minutes is not yet silence')
  assert.ok(kept.pets.every((en, i) => en.pet.tick === two.pets[i].pet.tick + 1), 'one tick for every pet')
  assert.deepEqual(tickWorld(two, { now: NOW + SILENCE_MS + 1, rand: first }).pets.map((en) => en.sid), ['grok__s2'])
  assert.equal(tickWorld(two, { now: NOW + 60_000 + SILENCE_MS + 1, rand: first }).pets.length, 0)
})

test('hatOf decides the hat when the event names none: event hat, then hatOf, then the pinned hat, then a random one', () => {
  const hats = { codex__s1: 'halo', grok__s2: 'sombrero', devin__d3: 'constructor' }
  const hatOf = (sid) => hats[sid] ?? null
  const hatIn = (world, e, opts = {}) => petOf(play(world, [e], { hatOf, ...opts }), e.sid).pet.hat
  const pinned = createWorld({ prefs: { hat: 'crown' } })

  assert.equal(hatIn(createWorld(), ev({ ev: 'tool.post', kind: 'todo', ok: true })), 'halo')
  assert.equal(hatIn(createWorld(), ev({ ev: 'session.start', hat: 'chef' })), 'chef', "the event's own hat wins")
  assert.equal(hatIn(pinned, ev({ ev: 'prompt.submit' })), 'halo', 'hatOf beats the pinned hat')
  assert.equal(hatIn(pinned, ev({ sid: 'grok__s2', ev: 'prompt.submit' })), 'crown', 'not a hat: the pinned one')
  assert.equal(hatIn(createWorld(), ev({ sid: 'devin__d3', ev: 'prompt.submit' })), randomHat(first), 'not an own hat name either')
  const broken = () => {
    throw new Error('store gone')
  }
  assert.equal(hatIn(pinned, ev({ ev: 'prompt.submit' }), { hatOf: broken }), 'crown', 'a failing lookup is no answer')

  const seeded = seedWorld(createWorld(), [ev({ ev: 'prompt.submit', t: minutesAgo(1) })], { now: NOW, rand: first, hatOf })
  assert.equal(petOf(seeded).pet.hat, 'halo', 'seeding asks hatOf too')
  assert.ok(applyPrefs(seeded, { shades: true }).pets.every((en) => en.pet.shades))
})

test('clawd-watch.mjs re-exports the world (the same functions, not copies) and still exports every name it did', () => {
  const moved = { BIG_TURN_MS, SILENCE_MS, applyPrefs, createWorld, reduce, seedWorld, tickWorld }
  for (const [name, value] of Object.entries(moved)) assert.equal(pane[name], value, name)
  assert.deepEqual(Object.keys(pane).sort(), [
    'BIG_TURN_MS',
    'SILENCE_MS',
    'applyPrefs',
    'composeRows',
    'createFollower',
    'createWorld',
    'fitText',
    'parseEventLines',
    'printable',
    'reduce',
    'seedWorld',
    'spriteWidth',
    'startWatch',
    'textWidth',
    'tickWorld',
    'watch',
  ])
})
