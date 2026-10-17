// Clawd pets for the dashboard page: the same world `agent-mods clawd watch` runs (clawd-world.mjs),
// fed the live activity lines and ticked on one shared 100 ms clock, drawn on canvases that are made
// once per tile and kept for as long as the page uses them.
//
// The world holds a pet for every session that logged an event in the last 30 minutes. Every other
// live session gets a pet made here from the snapshot (asleep when idle, pacing when working, "your
// call" when waiting), and the world takes it over as soon as that session logs an event. The
// snapshot also corrects a mood the events missed: the default Claude home has no Notification hook,
// so only the snapshot knows a session is waiting.
//
// Cost: only tiles on screen are drawn (an IntersectionObserver says which), a tile is drawn only
// when the cells it shows changed, and under reduced motion the clock runs once a second and a tile
// is drawn only when its still pose changes.
import { SILENCE_MS, applyPrefs, createWorld, reduce, seedWorld } from './clawd-world.mjs'
import {
  NONE,
  PX_ROWS,
  QUIPS,
  SPRITE_W,
  TICK_MS,
  WEARABLE,
  advance,
  frame,
  newPet,
  playCommand,
  say,
  setMood,
  validHat,
  wake,
} from './clawd-sprite.mjs'

// Columns of the world. Working pets pace across all of it; resting ones sit in its right corner.
export const WORLD_W = 24
// A session that finished within this long still celebrates.
export const RECENT_MS = 60_000
// The hats a person can pick: the nightcap is for naps.
export const PICKABLE_HATS = WEARABLE.filter((hat) => hat !== 'nightcap')
export const ASK_BUBBLE = QUIPS.ask[0]
// What a napping pet says the whole nap (the sprite's advance() puts it there).
export const SLEEP_BUBBLE = 'zzz…'

// What each tile shows: `from` is the first world column drawn, `cols` how many, `scale` the CSS
// pixels per sprite pixel. A resting pet sits in the right corner, so `from` centres it; a tile
// that `follow`s keeps the pet in view wherever it paces.
const KINDS = {
  work: { from: 0, cols: WORLD_W, scale: 4 },
  strip: { from: 0, cols: WORLD_W, scale: 6 },
  done: { from: WORLD_W - SPRITE_W - 2, cols: SPRITE_W + 4, scale: 3 },
  xl: { from: WORLD_W - SPRITE_W - 2, cols: SPRITE_W + 4, scale: 6 },
  xs: { from: WORLD_W - SPRITE_W, cols: SPRITE_W, scale: 2, follow: true },
  hat: { from: WORLD_W - SPRITE_W - 2, cols: SPRITE_W + 4, scale: 3 },
}
// The pose for a still frame: eyes open, looking ahead, legs together, no bounce.
const STILL_TICK = 28
const ECHO_MS = 15_000
// Under reduced motion the clock runs this many ticks at once, once a second: moods, bubbles and
// naps still end on time, and nothing is drawn ten times a second.
const STILL_TICKS = 10
// A tile this close to the viewport is drawn too, so a scrolled-in pet is already there.
const NEAR_VIEW = '64px'

const HAT_WORDS = {
  tophat: 'a top hat',
  party: 'a party hat',
  crown: 'a crown',
  wizard: 'a wizard hat',
  cowboy: 'a cowboy hat',
  propeller: 'a propeller hat',
  chef: "a chef's hat",
  viking: 'a viking helmet',
  halo: 'a halo hat',
  santa: 'a Santa hat',
  nightcap: 'a nightcap',
}

// The sprite's palette is a few dozen colours: each colour string is made once.
const HEX = new Map()
function hex(value) {
  let text = HEX.get(value)
  if (text === undefined) {
    text = `#${value.toString(16).padStart(6, '0')}`
    HEX.set(value, text)
  }
  return text
}

// A hat for a session the store has none for, the same one every time for that key.
function hatFor(key) {
  let n = 0
  for (const ch of String(key)) n = (n * 31 + ch.codePointAt(0)) >>> 0
  return PICKABLE_HATS[n % PICKABLE_HATS.length]
}

export function hatWords(hat) {
  return HAT_WORDS[hat] ?? 'a hat'
}

// A still frame of a pet: what reduced motion shows, and what static tiles draw.
function pose({ hat, mood = 'idle', shades = false, partyHat = false }) {
  const p = newPet({ hat: validHat(hat) ?? 'tophat', shades, partyHat, width: WORLD_W, x: WORLD_W - SPRITE_W, tick: STILL_TICK })
  p.mood = mood === 'dance' ? 'idle' : mood
  return frame(p)
}

function makeTile(kind, className) {
  const k = KINDS[kind]
  const el = document.createElement('span')
  el.className = className
  el.setAttribute('role', 'img')
  const canvas = document.createElement('canvas')
  canvas.width = k.cols * k.scale
  canvas.height = PX_ROWS * k.scale
  const ctx = canvas.getContext('2d')
  if (ctx) ctx.imageSmoothingEnabled = false
  el.append(canvas)
  return { el, canvas, ctx, k, cells: null, pose: '', label: '', visible: true }
}

// Copies the cells a tile shows (`from`, `cols` of the frame) into its cell list. True when any of
// them changed, which is the only time the tile is drawn again.
function takeCells(tile, px, from) {
  const size = PX_ROWS * tile.k.cols
  if (tile.cells?.length !== size) tile.cells = new Array(size).fill(-1)
  const cells = tile.cells
  let changed = false
  let i = 0
  for (let y = 0; y < PX_ROWS; y++) {
    const row = px[y] ?? []
    for (let c = 0; c < tile.k.cols; c++, i++) {
      const v = row[from + c] ?? NONE
      if (cells[i] !== v) {
        cells[i] = v
        changed = true
      }
    }
  }
  return changed
}

function paintCells(tile) {
  const { ctx, canvas, k, cells } = tile
  if (!ctx || !cells) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i]
    if (v === NONE) continue
    ctx.fillStyle = hex(v)
    ctx.fillRect((i % k.cols) * k.scale, Math.floor(i / k.cols) * k.scale, k.scale, k.scale)
  }
}

function draw(tile, px, from = tile.k.from) {
  if (takeCells(tile, px, from)) paintCells(tile)
}

// clock: the page's estimate of the server's time (activity times are the server's). rand: the
// randomness every pet uses (tests pass their own).
export function createPets({ clock = () => Date.now(), reduced = false, onBubble = () => {}, rand = Math.random } = {}) {
  let world = createWorld({ width: WORLD_W })
  let index = new Map()
  let lastPrefs = ''
  let frozen = false
  let still = reduced
  let timer = null
  let timerEvery = 0
  const info = new Map() // session key -> { hat, state, since }
  const pagePets = new Map() // session key -> pet, for sessions the world does not hold
  const freePets = new Map() // id -> pet, not tied to a session (empty states)
  const tiles = new Map() // id -> live tile
  const statics = new Map() // id -> still tile, drawn once
  const bubbles = new Map() // session key -> the bubble last reported
  const recheck = new Set() // session keys whose pet should be checked against the snapshot
  const echoes = [] // commands played here, waiting for their own clawd.cmd line

  const hatOf = (sid) => info.get(sid)?.hat ?? null

  function reindex() {
    index = new Map(world.pets.map((en) => [en.sid, en]))
  }

  function needsPet(entry) {
    return Boolean(entry) && entry.state !== 'open' && entry.state !== 'ended'
  }

  // A pet for a session the world does not hold: what the snapshot says it is doing.
  function pagePet(key, entry) {
    const p = newPet({ hat: validHat(entry.hat) ?? world.pinned ?? hatFor(key), shades: world.shades, width: WORLD_W })
    if (entry.state === 'working') setMood(p, 'work')
    else if (entry.state === 'waiting') say(p, ASK_BUBBLE, 30)
    else if (clock() - entry.since < RECENT_MS) setMood(p, 'party', Math.round((RECENT_MS - (clock() - entry.since)) / TICK_MS))
    else p.mood = 'sleep'
    return p
  }

  function petOf(key) {
    if (key.startsWith('free:')) return freePets.get(key.slice(5)) ?? null
    const en = index.get(key)
    if (en) return en.pet
    const page = pagePets.get(key)
    if (page) return page
    const entry = info.get(key)
    if (!needsPet(entry)) return null
    const made = pagePet(key, entry)
    pagePets.set(key, made)
    return made
  }

  // Brings a pet's mood in line with the snapshot's state when the events missed the change.
  function reconcile(key) {
    const entry = info.get(key)
    if (!needsPet(entry)) return
    const en = index.get(key)
    const p = en ? en.pet : pagePets.get(key)
    if (!p) return
    if (entry.state === 'working') {
      if (!['work', 'dance', 'party'].includes(p.mood)) {
        wake(p, rand)
        setMood(p, 'work')
      }
      if (en) en.waiting = false
    } else if (entry.state === 'waiting') {
      if (p.mood === 'work') setMood(p, 'idle')
      attend(key)
    } else if (entry.state === 'idle') {
      if (en) en.waiting = false
      if (p.mood === 'work') {
        const left = RECENT_MS - (clock() - entry.since)
        if (left > 0) setMood(p, 'party', Math.round(left / TICK_MS))
        else setMood(p, 'idle')
      }
    }
  }

  // A session the snapshot says is waiting keeps its pet awake and asking, however long it waits.
  function attend(key) {
    const en = index.get(key)
    const p = en ? en.pet : pagePets.get(key)
    if (!p) return
    if (p.mood === 'sleep') {
      p.mood = 'idle'
      p.particles = p.particles.filter((q) => q.kind !== 'z')
    }
    if (p.mood === 'idle' && p.bubble !== ASK_BUBBLE) say(p, ASK_BUBBLE, 30)
    p.lastActive = p.tick
    if (en) en.waiting = true
  }

  // After the world changed: a pet it now holds stops being a page pet, and every pet the world
  // just took on is checked once against the snapshot.
  function settle() {
    const before = index
    reindex()
    for (const key of index.keys()) if (!before.has(key)) recheck.add(key)
    for (const key of [...pagePets.keys()]) if (index.has(key)) pagePets.delete(key)
    for (const key of recheck) reconcile(key)
    recheck.clear()
  }

  const toEvent = (line) => (line && typeof line === 'object' ? { ...line, sid: line.key ?? null, pk: line.projectId ?? null } : null)

  // A clawd.cmd line for a command this page already played: only its global part (pinned hat,
  // shades, hidden) still has to reach the world.
  function takeEcho(e) {
    const at = Date.now()
    for (let i = echoes.length - 1; i >= 0; i--) if (echoes[i].until < at) echoes.splice(i, 1)
    const i = echoes.findIndex((x) => x.verb === e.verb && x.sid === (e.sid ?? null))
    if (i < 0) return false
    echoes.splice(i, 1)
    const next = { hat: world.pinned, shades: world.shades, hidden: world.hidden }
    if (typeof e.shades === 'boolean') next.shades = e.shades
    if (typeof e.hidden === 'boolean') next.hidden = e.hidden
    if (e.verb === 'hat' && e.ok !== false && validHat(e.hat)) next.hat = e.arg === 'random' ? null : e.hat
    world = applyPrefs(world, next)
    return true
  }

  function apply(e, now) {
    if (e.ev === 'clawd.cmd' && takeEcho(e)) return
    world = reduce(world, e, { now, rand, hatOf })
  }

  // The lines a page gets when it connects: older ones only place pets (no replayed animations),
  // the last minute plays as it happened.
  function seed(lines) {
    const now = clock()
    const events = (Array.isArray(lines) ? lines : []).map(toEvent).filter(Boolean)
    world = seedWorld(
      world,
      events.filter((e) => now - e.t > RECENT_MS),
      { now, rand, hatOf },
    )
    for (const e of events) if (now - e.t <= RECENT_MS) apply(e, now)
    settle()
    paintAll()
  }

  function feed(lines) {
    const now = clock()
    for (const e of (Array.isArray(lines) ? lines : []).map(toEvent)) if (e) apply(e, now)
    settle()
    paintAll()
  }

  // The snapshot: which sessions exist and what state each is in, plus clawd.json's prefs.
  function sync(sessions, prefs) {
    const text = JSON.stringify(prefs ?? {})
    if (text !== lastPrefs) {
      lastPrefs = text
      world = applyPrefs(world, prefs ?? {})
      for (const p of pagePets.values()) p.shades = world.shades
      reindex()
    }
    const seen = new Set()
    for (const s of Array.isArray(sessions) ? sessions : []) {
      if (!s || typeof s.key !== 'string') continue
      seen.add(s.key)
      const before = info.get(s.key)
      const entry = { hat: validHat(s.hat), state: s.state, since: Number(s.since) || 0 }
      info.set(s.key, entry)
      if (!before || before.state !== entry.state) recheck.add(s.key)
    }
    for (const key of [...info.keys()]) {
      if (seen.has(key)) continue
      info.delete(key)
      bubbles.delete(key)
    }
    for (const key of [...pagePets.keys()]) if (!needsPet(info.get(key))) pagePets.delete(key)
    settle()
    paintAll()
  }

  // A turn that finished in the last minute keeps celebrating until the minute is up.
  function celebrate(key, finishedAt) {
    const left = RECENT_MS - (clock() - finishedAt)
    if (left <= 0) return
    const en = index.get(key)
    const p = en ? en.pet : pagePets.get(key)
    if (p && p.mood === 'idle') setMood(p, 'party', Math.round(left / TICK_MS))
  }

  // A /clawd command sent from this page plays at once; its log line, when it arrives, is not
  // played a second time.
  function play(key, cmd) {
    const targets = key ? [petOf(key)].filter(Boolean) : [...world.pets.map((en) => en.pet), ...pagePets.values()]
    for (const p of targets) {
      if (key && cmd.verb !== 'hat' && validHat(cmd.hat)) p.hat = cmd.hat
      playCommand(p, cmd, rand)
    }
    if (!key && (typeof cmd.shades === 'boolean' || cmd.verb === 'hat')) {
      const next = { hat: world.pinned, shades: typeof cmd.shades === 'boolean' ? cmd.shades : world.shades, hidden: world.hidden }
      if (cmd.verb === 'hat' && validHat(cmd.hat)) next.hat = cmd.arg === 'random' ? null : cmd.hat
      world = applyPrefs(world, next)
      reindex()
    }
    echoes.push({ verb: cmd.verb, sid: key ?? null, until: Date.now() + ECHO_MS })
    paintAll()
  }

  function labelOf(p, key) {
    const state = info.get(key)?.state
    const mood =
      state === 'waiting'
        ? 'needs you'
        : p.mood === 'sleep'
          ? 'napping'
          : p.mood === 'work'
            ? 'working'
            : p.mood === 'party'
              ? 'celebrating'
              : p.mood === 'dance'
                ? 'dancing'
                : 'idle'
    return `Clawd in ${hatWords(p.hat)}${p.shades ? ' and shades' : ''}, ${mood}`
  }

  // The label is kept current on every tile, on screen or not (a screen reader reads them all); the
  // canvas only on tiles that can be seen.
  function paintTile(tile) {
    if (!tile.el.isConnected) return
    const p = petOf(tile.key)
    if (!p) {
      if (tile.pose !== 'none') {
        tile.ctx?.clearRect(0, 0, tile.canvas.width, tile.canvas.height)
        tile.cells = null
        tile.pose = 'none'
      }
      return
    }
    const label = labelOf(p, tile.key)
    if (label !== tile.label) {
      tile.el.setAttribute('aria-label', label)
      tile.label = label
    }
    if (!tile.visible) return
    if (still) {
      // pose() reads only these four, so the same four draw the same frame.
      const key = `${p.hat}|${p.mood}|${p.shades}|${p.partyHat}`
      if (key !== tile.pose) {
        tile.pose = key
        draw(tile, pose(p))
      }
      return
    }
    tile.pose = ''
    draw(tile, frame(p), tile.k.follow ? Math.max(0, Math.min(p.x, WORLD_W - SPRITE_W)) : tile.k.from)
  }

  function paintAll() {
    const keys = new Set()
    for (const tile of tiles.values()) {
      paintTile(tile)
      if (!tile.key.startsWith('free:')) keys.add(tile.key)
    }
    for (const key of keys) {
      const text = petOf(key)?.bubble ?? ''
      if (bubbles.get(key) !== text) {
        bubbles.set(key, text)
        onBubble(key, text)
      }
    }
  }

  // tickWorld's rules without its copy: tickWorld clones every pet on every tick, the biggest cost
  // here with many sessions, and this page holds the only reference to its world (play, reconcile
  // and attend already change its pets in place). A pet silent for SILENCE_MS goes; every other one
  // advances a tick. True when a pet went.
  function advanceWorld(now) {
    const kept = world.pets.filter((en) => now - en.seenAt <= SILENCE_MS)
    const gone = kept.length !== world.pets.length
    if (gone) world = { ...world, pets: kept }
    for (const en of world.pets) {
      en.pet.width = WORLD_W
      advance(en.pet, rand)
    }
    return gone
  }

  function tick(n) {
    const now = clock()
    let gone = false
    for (let i = 0; i < n; i++) gone = advanceWorld(now) || gone
    for (const p of pagePets.values()) {
      p.width = WORLD_W
      for (let i = 0; i < n; i++) advance(p, rand)
    }
    for (const p of freePets.values()) for (let i = 0; i < n; i++) advance(p, rand)
    if (gone) settle()
    paintAll()
  }

  // One clock for every pet, stopped while the page is hidden or the connection is gone. Under
  // reduced motion it runs once a second and catches up the ticks it skipped.
  function run() {
    const should = !frozen && !document.hidden
    const every = still ? TICK_MS * STILL_TICKS : TICK_MS
    if (timer && (!should || every !== timerEvery)) {
      clearInterval(timer)
      timer = null
    }
    if (should && !timer) {
      timerEvery = every
      timer = setInterval(() => tick(still ? STILL_TICKS : 1), every)
    }
  }
  document.addEventListener('visibilitychange', run)
  run()

  // Which tiles can be seen. Without an IntersectionObserver every tile counts as seen.
  const byElement = new WeakMap()
  const watcher =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const known = byElement.get(entry.target)
              if (!known) continue
              known.visible = entry.isIntersecting
              if (known.visible) paintTile(known)
            }
          },
          { rootMargin: NEAR_VIEW },
        )
      : null

  // A live tile: the pet of `key` (a session key), drawn every time the cells it shows change. The
  // same id always returns the same element.
  function tile(id, key, kind, extraClass = '') {
    const known = tiles.get(id)
    if (known) return known.el
    const made = makeTile(kind, `tile tile-${kind}${extraClass ? ` ${extraClass}` : ''}`)
    made.key = key
    tiles.set(id, made)
    byElement.set(made.el, made)
    watcher?.observe(made.el)
    queueMicrotask(() => paintTile(made))
    return made.el
  }

  // An animated pet for an empty state: asleep unless told otherwise.
  function free(id, { hat = 'tophat', mood = 'sleep', kind = 'done' } = {}) {
    if (!freePets.has(id)) {
      const p = newPet({ hat, width: WORLD_W })
      p.mood = mood
      freePets.set(id, p)
    }
    return tile(`free:${id}`, `free:${id}`, kind)
  }

  // A still pet, drawn once: ended sessions, the hat picker, previews.
  function stillTile(id, { hat, mood = 'idle', shades = false, kind = 'done', grey = false, label = '' }) {
    const sig = `${hat}|${mood}|${shades}|${kind}|${grey}`
    const known = statics.get(id)
    if (known && known.sig === sig) return known.el
    const made = known && known.kind === kind ? known : makeTile(kind, `tile tile-${kind === 'hat' ? 'hat' : 'still'}${grey ? ' tile-grey' : ''}`)
    made.el.className = `tile tile-${kind === 'hat' ? 'hat' : 'still'}${grey ? ' tile-grey' : ''}`
    draw(made, pose({ hat, mood, shades }))
    made.sig = sig
    made.kind = kind
    if (label) made.el.setAttribute('aria-label', label)
    else {
      made.el.removeAttribute('role')
      made.el.setAttribute('aria-hidden', 'true')
    }
    statics.set(id, made)
    return made.el
  }

  function release(id) {
    const known = tiles.get(id)
    if (known) watcher?.unobserve(known.el)
    tiles.delete(id)
    statics.delete(id)
    if (id.startsWith('free:')) freePets.delete(id.slice(5))
  }

  return {
    seed,
    feed,
    sync,
    play,
    celebrate,
    attend,
    tile,
    free,
    still: stillTile,
    release,
    bubbleOf: (key) => petOf(key)?.bubble ?? '',
    hatOf: (key) => petOf(key)?.hat ?? hatOf(key),
    setFrozen(on) {
      frozen = Boolean(on)
      run()
    },
    setReduced(on) {
      still = Boolean(on)
      for (const t of tiles.values()) t.pose = ''
      run()
      paintAll()
    },
  }
}
