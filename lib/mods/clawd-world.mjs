// The Clawd world: one pet per session, and what each logged event does to it. These pure functions
// moved here from clawd-watch.mjs so the dashboard page can import this file unchanged and run the
// same pets as `agent-mods clawd watch`, on the same 100 ms tick. It imports only the sprite and uses
// nothing a browser lacks: the clock, the randomness and the per-session hat lookup (hatOf) come in
// as arguments, and no function changes the world it is given.
//
// Store: none. The caller reads events/YYYY-MM-DD.jsonl, clawd.json and sessions/<key>/clawd.json
// and passes in what it read.
import {
  MAX_W,
  QUIPS,
  TICK_MS,
  advance,
  newPet,
  pick,
  playCommand,
  randomHat,
  say,
  setMood,
  spawn,
  toolLine,
  validHat,
  wake,
} from './clawd-sprite.mjs'

export const SILENCE_MS = 30 * 60_000
export const BIG_TURN_MS = 60_000
export const SESSION_EVENTS = new Set(['session.start', 'prompt.submit', 'tool.post', 'turn.stop', 'notify'])

// Exported for clawd-watch.mjs's log parser, so the follower and the reducer agree on what an event is.
export const isEvent = (e) => Boolean(e) && typeof e === 'object' && typeof e.ev === 'string'
const isSid = (sid) => typeof sid === 'string' && sid.length > 0 && sid.length < 200
const inView = (world, e) => !world.filter || e.pk === world.filter
const timeOf = (e, now) => (Number.isFinite(e.t) ? e.t : now)

// prefs: clawd.json as readPrefs() returns it. filter: a projectId, or null for every project.
export function createWorld({ prefs = {}, filter = null, width = MAX_W } = {}) {
  return {
    pets: [],
    filter,
    width,
    pinned: validHat(prefs.hat),
    shades: prefs.shades === true,
    hidden: prefs.hidden === true,
  }
}

// clawd.json changed on disk (normally a /clawd command already said so through the log).
export function applyPrefs(world, prefs) {
  const shades = prefs.shades === true
  return {
    ...world,
    pinned: validHat(prefs.hat),
    hidden: prefs.hidden === true,
    shades,
    pets: world.pets.map((en) => (en.pet.shades === shades ? en : { ...en, pet: { ...en.pet, shades } })),
  }
}

function lookupHat(hatOf, sid) {
  try {
    return validHat(hatOf(sid))
  } catch {
    return null
  }
}

function createEntry(world, e, { now, rand, hatOf }) {
  const hat = validHat(e.hat) ?? lookupHat(hatOf, e.sid) ?? world.pinned ?? randomHat(rand)
  return {
    sid: e.sid,
    agent: typeof e.agent === 'string' && e.agent ? e.agent : 'agent',
    project: typeof e.project === 'string' ? e.project : '',
    pk: typeof e.pk === 'string' ? e.pk : null,
    pet: newPet({ hat, shades: world.shades, width: world.width }),
    seenAt: timeOf(e, now),
    promptAt: 0,
    waiting: false,
  }
}

// One event in, the next world out. The moods follow the original's session.start, prompt.submit +
// turn.start, tool.call and turn.complete handlers (register.tsx:328-409). Stop carries no duration
// here, so a turn is timed from that session's prompt.submit.
export function reduce(world, e, { now = Date.now(), rand = Math.random, hatOf = () => null } = {}) {
  if (!isEvent(e)) return world
  if (e.ev === 'clawd.cmd') return command(world, e, { now, rand, hatOf })
  if (!isSid(e.sid) || !inView(world, e)) return world
  if (e.ev === 'session.end') return { ...world, pets: world.pets.filter((en) => en.sid !== e.sid) }
  if (!SESSION_EVENTS.has(e.ev)) return world

  const at = world.pets.findIndex((en) => en.sid === e.sid)
  const en = at >= 0 ? structuredClone(world.pets[at]) : createEntry(world, e, { now, rand, hatOf })
  const t = timeOf(e, now)
  en.seenAt = Math.max(en.seenAt, t)
  const p = en.pet

  if (e.ev === 'session.start') {
    if (at < 0) {
      p.lastActive = p.tick
      say(p, world.pinned && world.pinned === p.hat ? 'hi! 👋' : `hi! today's hat: ${p.hat}`, 6)
    } else {
      if (validHat(e.hat)) p.hat = e.hat
      wake(p, rand)
    }
  } else if (e.ev === 'prompt.submit') {
    wake(p, rand)
    setMood(p, 'work')
    say(p, pick(QUIPS.start, rand), 3)
    en.promptAt = t
    en.waiting = false
  } else if (e.ev === 'tool.post') {
    // A tool finishing means the agent is working, even when the prompt went by before this pane
    // started or Clawd was waiting on a permission prompt (the original went back to work after a
    // question the same way).
    if (p.mood === 'idle' || p.mood === 'sleep') {
      wake(p, rand)
      setMood(p, 'work')
    }
    p.lastActive = p.tick
    en.waiting = false
    if (e.ok === false) {
      spawn(p, 'sweat', 2, rand)
      say(p, pick(QUIPS.oops, rand), 3)
    } else {
      const line = toolLine(e.kind, e.label)
      if (line) say(p, line, 4, true)
      else if (e.kind === 'ask') say(p, 'thanks!', 2)
    }
  } else if (e.ev === 'turn.stop') {
    p.lastActive = p.tick
    const isBig = en.promptAt > 0 && t - en.promptAt > BIG_TURN_MS
    p.partyHat = isBig
    setMood(p, 'party', isBig ? 40 : 20)
    spawn(p, 'sparkle', 4, rand)
    say(p, pick(isBig ? QUIPS.bigDone : QUIPS.done, rand))
  } else if (e.ev === 'notify') {
    wake(p, rand)
    setMood(p, 'idle')
    say(p, QUIPS.ask[0], 30)
    en.waiting = true
  }

  const pets = at >= 0 ? world.pets.map((x, i) => (i === at ? en : x)) : [...world.pets, en]
  return { ...world, pets }
}

// A /clawd command: shades, hidden and the pinned hat are global; the animation plays on the calling
// session's pet, or on every pet when the command came from outside any session.
function command(world, e, { now, rand, hatOf }) {
  const next = { ...world }
  const shades = typeof e.shades === 'boolean' ? e.shades : null
  if (shades !== null) next.shades = shades
  if (typeof e.hidden === 'boolean') next.hidden = e.hidden
  if (e.verb === 'hat' && e.ok !== false && validHat(e.hat)) next.pinned = e.arg === 'random' ? null : e.hat

  const targeted = isSid(e.sid)
  let pets = world.pets
  if (targeted && inView(world, e) && !pets.some((en) => en.sid === e.sid)) {
    pets = [...pets, createEntry(next, e, { now, rand, hatOf })]
  }
  next.pets = pets.map((en) => {
    const hit = targeted ? en.sid === e.sid : true
    if (!hit && shades === null) return en
    const c = structuredClone(en)
    if (shades !== null) c.pet.shades = shades
    if (!hit) return c
    if (targeted) {
      c.seenAt = Math.max(c.seenAt, timeOf(e, now))
      if (e.verb !== 'hat' && validHat(e.hat)) c.pet.hat = e.hat
    }
    playCommand(c.pet, e, rand)
    return c
  })
  return next
}

// Pets for the sessions already running when the pane opens, from the recent log, without replaying
// their animations: working ones pace, waiting ones keep their tag, long-idle ones are asleep.
export function seedWorld(world, events, { now = Date.now(), rand = Math.random, hatOf = () => null } = {}) {
  const seen = new Map()
  for (const e of events) {
    if (!isEvent(e) || !isSid(e.sid)) continue
    if (e.ev === 'clawd.cmd') {
      if (seen.has(e.sid) && validHat(e.hat)) seen.get(e.sid).hat = e.hat
      continue
    }
    if (!inView(world, e)) continue
    let s = seen.get(e.sid)
    if (!s) {
      s = { sid: e.sid, agent: e.agent, project: e.project, pk: e.pk, hat: null, t: 0, ended: false, working: false, waiting: false, promptAt: 0 }
      seen.set(e.sid, s)
    }
    const t = timeOf(e, now)
    s.t = Math.max(s.t, t)
    if (e.ev === 'session.start') {
      s.ended = false
      if (validHat(e.hat)) s.hat = e.hat
    } else if (e.ev === 'prompt.submit') {
      s.working = true
      s.waiting = false
      s.promptAt = t
    } else if (e.ev === 'tool.post') {
      s.working = true
      s.waiting = false
    } else if (e.ev === 'turn.stop') {
      s.working = false
    } else if (e.ev === 'notify') {
      s.working = false
      s.waiting = true
    } else if (e.ev === 'session.end') {
      s.ended = true
    }
  }
  const pets = [...world.pets]
  for (const s of seen.values()) {
    if (s.ended || now - s.t > SILENCE_MS || pets.some((en) => en.sid === s.sid)) continue
    const en = createEntry(world, s, { now, rand, hatOf })
    en.pet.mood = s.working ? 'work' : 'idle'
    en.pet.lastActive = -Math.round((now - s.t) / TICK_MS)
    en.promptAt = s.promptAt
    en.waiting = s.waiting
    pets.push(en)
  }
  return { ...world, pets }
}

// The original's 100 ms clock, for every pet; a session silent for 30 minutes loses its pet.
export function tickWorld(world, { now = Date.now(), width = world.width, rand = Math.random } = {}) {
  const pets = []
  for (const en of world.pets) {
    if (now - en.seenAt > SILENCE_MS) continue
    const c = structuredClone(en)
    c.pet.width = width
    advance(c.pet, rand)
    pets.push(c)
  }
  return { ...world, width, pets }
}
