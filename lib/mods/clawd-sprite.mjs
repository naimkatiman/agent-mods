// Clawd's sprite and behaviour, ported from claude-mods clawd-pet/hooks/register.tsx. Everything here
// is pure data or works on the pet object it is given (no files, no terminal, no module-level pet), so
// the renderer keeps one pet per session and the tests drive it tick by tick.
//
// Changes from the original, each deliberate:
// - COLORS is complete. In register.tsx:53 a `//` comment swallowed R, P, Y, G and J, which then
//   painted black (6 of the 11 hats, hearts, notes and sparkle arms).
// - spawn() takes the pet it changes (the original always changed the module-level pet).
// - base() splits on '\' as well as '/', for Windows paths.
// - Hat lookups use own keys only, so a name like "constructor" is not a hat.
// - cells() (Claude's base64 Raster encoding) becomes halfBlocks() + toAnsi(): the same half-block
//   rules, written as 24-bit ANSI for a plain terminal.

export const NONE = 0x01000000
export const TICK_MS = 100
export const PX_ROWS = 8 // two pixels per terminal row: 4 rows tall, the size of the logo
export const ROWS = PX_ROWS / 2
export const BASE_Y = 3 // body top; the hat takes the three pixel rows above
export const SPRITE_W = 12
export const MAX_W = 30 // pacing room while the agent works
export const SLEEP_AFTER = 3000 // ticks idle (5 minutes) before a nap
export const MOODS = ['idle', 'work', 'party', 'dance', 'sleep']

// Body, five pixel rows. E is an eye, A an arm, L a leg.
export const BODY = [
  '..OOOOOOOO..',
  '..OEOOOOEO..',
  'AAOOOOOOOOAA',
  '..OOOOOOOO..',
  '..L.L..L.L..',
]
export const LEGS_STEP = '...LL..LL...'

// Hats sit on the row above the head, at most three pixel rows.
export const HATS = {
  tophat: ['....KKKK....', '....RRRR....', '..KKKKKKKK..'],
  party: ['.....YY.....', '....PYYP....', '...YPPPPY...'],
  crown: ['..G..GG..G..', '..GGGGGGGG..', '..GJGBBGJG..'],
  wizard: ['.....UU.....', '....USUU....', '.UUUUUUUUUU.'],
  cowboy: ['....N..N....', '...NNNNNN...', 'NNNDDDDDDNNN'],
  propeller: ['.RRR.YY.BBB.', '.....YY.....', '..BRRBBRRB..'],
  chef: ['...WW.WW....', '..WWWWWWWW..', '...wwwwww...'],
  viking: ['I..........I', 'II.HHHHHH.II', '..HHhHHhHH..'],
  halo: ['...GGGGGG...', '..G......G..', '...GGGGGG...'],
  santa: ['.........WW.', '.....RRRRRW.', '..WWWWWWWW..'],
  nightcap: ['.W..........', '..WBBWWB....', '..BBWWBBWW..'],
}
// The propeller's other frame, swapped in while it spins.
export const PROPELLER_SPIN = '...RRYYBB...'
export const WEARABLE = Object.keys(HATS)

export const SHADES = '..SSSWWSSS..'
export const LENS = [0xff2bd6, 0xb03cff, 0x5b4dff]

export const COLORS = {
  O: 0xd77757, A: 0xd77757, L: 0xd77757, E: 0x000000,
  K: 0x585868, // light enough to show on a dark terminal
  R: 0xe03c3c, P: 0xff5fa8, Y: 0xffd23f, G: 0xffc400, J: 0xe0245e,
  B: 0x3c7be0, U: 0x7a4fd6, S: 0xffe66d, N: 0x8b5a2b, D: 0x3d2414, W: 0xf4f4f4,
  w: 0xcfcfcf, H: 0x9aa3ad, h: 0x5c6670, I: 0xf3e5c0,
}

export const SHAPES = {
  heart: ['R.R', '.R.'],
  sparkle: ['.Y.', 'YWY', '.Y.'],
  z: ['WW', '.W', 'WW'],
  sweat: ['B', 'B'],
  note: ['.Y', 'YY'],
}
export const LIFE = { heart: 14, sparkle: 6, z: 20, sweat: 6, note: 12 }

export const QUIPS = {
  start: ['on it!', "let's go", 'hmm, thinking…', 'ooh, fun one', 'rolling up my claws'],
  done: ['done! ✨', 'ta-da!', 'nailed it', 'ship it 🚀', 'that was fun'],
  bigDone: ['phew, big one! 🎉', 'we did it! 🎉', 'marathon complete 🏁'],
  stopped: ['ok, stopping ✋', 'halted', 'pausing here'],
  oops: ['oops 😅', 'hmm, that failed', 'uh oh', 'retrying in my head…'],
  pet: ['♥', 'hehe', 'more pets pls', '*happy crab noises*'],
  wake: ['oh! I’m up', '*yawn* hi', 'was I asleep? no.'],
  ask: ['your call 👀', 'what do you think?', 'over to you'],
}

export const HELP =
  '/clawd hat [name|random] · /clawd hats · /clawd pet · /clawd dance · /clawd party · /clawd shades · /clawd hide · /clawd show'

export const pick = (xs, rand = Math.random) => xs[Math.floor(rand() * xs.length)]
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
export const base = (p) => (typeof p === 'string' ? p.split(/[\\/]/).pop() ?? p : '')

export function validHat(name) {
  return typeof name === 'string' && Object.hasOwn(HATS, name) ? name : null
}

// A new random hat: never the nightcap (that one is for naps), never the one being replaced.
export function randomHat(rand = Math.random, except = null) {
  return pick(WEARABLE.filter((h) => h !== 'nightcap' && h !== except), rand)
}

// The original's module-level pet, one per session here, plus the bubble state the original kept in
// an atom and two module variables.
export function newPet(overrides = {}) {
  return {
    tick: 0,
    mood: 'idle',
    moodUntil: 0,
    lastActive: 0,
    hat: 'tophat',
    partyHat: false,
    shades: false,
    x: 999, // starts in the right corner (clamped to the raster)
    dir: -1,
    width: 24,
    particles: [],
    bubble: '',
    bubbleUntil: 0,
    bubbleAt: -100,
    ...overrides,
  }
}

// One frame, as rows of 0xRRGGBB (or NONE), PX_ROWS tall and p.width wide.
export function frame(p) {
  const t = p.tick
  const grid = Array.from({ length: PX_ROWS }, () => new Array(p.width).fill(NONE))
  const put = (x, y, c) => {
    if (y >= 0 && y < PX_ROWS && x >= 0 && x < p.width) grid[y][x] = c
  }

  let y = BASE_Y
  let x = Math.min(p.x, Math.max(0, p.width - SPRITE_W))
  let armsUp = false
  let wave = false
  let legs = BODY[4]
  let eyeShift = 0
  let eyesOpen = true

  if (p.mood === 'idle') {
    eyesOpen = t % 40 !== 0 && t % 40 !== 1 // blink
    eyeShift = t % 120 < 20 ? -1 : t % 120 > 100 ? 1 : 0 // glance around
    wave = t % 200 >= 180 && Math.floor(t / 3) % 2 === 0 // now and then, a wave
  } else if (p.mood === 'work') {
    legs = Math.floor(t / 2) % 2 ? LEGS_STEP : BODY[4]
    eyeShift = p.dir
  } else if (p.mood === 'party') {
    y -= [0, 1, 1, 0][t % 4]
    armsUp = true
  } else if (p.mood === 'dance') {
    const beat = Math.floor(t / 3) % 2
    x += beat ? 1 : -1
    armsUp = beat === 0
    legs = beat ? LEGS_STEP : BODY[4]
  } else if (p.mood === 'sleep') {
    eyesOpen = false
  }

  // Eyes go on after the whole body: painted inline, an eye shifted right was covered by the next body
  // pixel, so a pet walking or glancing right had none (the original register.tsx has the same bug).
  const eyes = []
  BODY.forEach((row, r) => {
    const line = r === 4 ? legs : row
    ;[...line].forEach((c, cx) => {
      if (c === '.') return
      if (c === 'A' && (armsUp || (wave && cx > 6))) return
      if (c === 'E') {
        put(x + cx, y + r, COLORS.O)
        if (eyesOpen) eyes.push([x + cx + eyeShift, y + r])
        return
      }
      put(x + cx, y + r, COLORS[c])
    })
  })
  for (const [ex, ey] of eyes) put(ex, ey, COLORS.E)
  if (p.mood === 'sleep') {
    // Closed eyes: a short dash each.
    for (const cx of [2, 3, 8, 9]) put(x + cx, y + 1, COLORS.E)
  }
  if (armsUp || wave) {
    // Thin arms raised from the shoulders (just the right one for a wave).
    for (const [dx, dy] of [[1, 1], [0, 0]]) {
      if (armsUp) put(x + dx, y + dy, COLORS.A)
      put(x + SPRITE_W - 1 - dx, y + dy, COLORS.A)
    }
  }

  if (p.shades && eyesOpen) {
    ;[...SHADES].forEach((c, cx) => {
      if (c === 'W') put(x + cx, y + 1, COLORS.W)
      if (c === 'S') put(x + cx, y + 1, (cx + 30 - (t % 30)) % 30 < 1 ? 0xffffff : LENS[cx % 3])
    })
  }

  const hatName = p.mood === 'sleep' ? 'nightcap' : p.partyHat ? 'party' : p.hat
  const hat = [...(validHat(hatName) ? HATS[hatName] : [])]
  if (hatName === 'propeller' && (p.mood === 'work' || p.mood === 'dance' || p.mood === 'party') && t % 2) {
    hat[0] = PROPELLER_SPIN
  }
  hat.forEach((row, r) =>
    [...row].forEach((c, cx) => {
      if (c !== '.') put(x + cx, y - hat.length + r, COLORS[c])
    }),
  )

  for (const q of p.particles) {
    SHAPES[q.kind].forEach((row, r) =>
      [...row].forEach((c, cx) => {
        if (c !== '.') put(q.x + cx, q.y + r, COLORS[c])
      }),
    )
  }
  return grid
}

// cells() semantics, as [codepoint, fg, bg] per terminal cell: both halves empty is a space,
// an empty top is ▄ in the bottom colour, otherwise ▀ with fg = top and bg = bottom. An empty half
// must stay the terminal background, never the default foreground.
export function halfBlocks(px) {
  const color = (c) => (Number.isInteger(c) && c >= 0 && c <= 0xffffff ? c : NONE)
  const rows = []
  for (let y = 0; y < px.length; y += 2) {
    rows.push(
      px[y].map((raw, x) => {
        const top = color(raw)
        const bottom = color(px[y + 1]?.[x])
        if (top === NONE && bottom === NONE) return [0x20, NONE, NONE]
        if (top === NONE) return [0x2584, bottom, NONE] // ▄
        return [0x2580, top, bottom] // ▀
      }),
    )
  }
  return rows
}

const rgb = (c) => `${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`
export const RESET = '\x1b[0m'

// One string per terminal row. Colours change only when they differ from the previous cell, and
// every row ends with a reset so nothing bleeds into the text beside it.
export function ansiLines(px) {
  return halfBlocks(px).map((row) => {
    let out = ''
    let fg = NONE
    let bg = NONE
    for (const [code, f, b] of row) {
      if (b !== bg) {
        out += b === NONE ? '\x1b[49m' : `\x1b[48;2;${rgb(b)}m`
        bg = b
      }
      if (code !== 0x20 && f !== fg) {
        out += `\x1b[38;2;${rgb(f)}m`
        fg = f
      }
      out += String.fromCodePoint(code)
    }
    return out + RESET
  })
}

export function toAnsi(px) {
  return ansiLines(px).join('\n')
}

export function spawn(p, kind, n, rand = Math.random) {
  for (let i = 0; i < n; i++) {
    const side = rand() < 0.5 ? -3 : SPRITE_W
    const x = kind === 'z' ? p.x + SPRITE_W - 1 : kind === 'sweat' ? p.x + 1 : p.x + side + Math.floor(rand() * 3)
    const y = kind === 'sweat' ? BASE_Y : kind === 'z' ? 2 : Math.floor(rand() * 4)
    p.particles.push({ kind, x, y, age: -i * 3 })
  }
}

// Advances one tick: moves Clawd and the particles, ends timed moods.
export function step(p, rand = Math.random) {
  p.tick += 1
  if (p.moodUntil && p.tick >= p.moodUntil) {
    p.mood = 'idle'
    p.moodUntil = 0
    p.partyHat = false
  }
  if (p.mood === 'idle' && p.tick - p.lastActive > SLEEP_AFTER) p.mood = 'sleep'

  const room = Math.max(0, p.width - SPRITE_W)
  if (p.mood === 'work' && p.tick % 2 === 0) {
    if (p.x + p.dir > room || p.x + p.dir < 0) p.dir = -p.dir
    p.x = Math.min(room, Math.max(0, p.x + p.dir))
  } else if (p.mood !== 'work' && p.x < room && p.tick % 2 === 0) {
    p.x += 1 // stroll back to the corner
    p.dir = 1
  }
  p.x = Math.min(p.x, room)

  if (p.mood === 'party' && p.tick % 3 === 0) spawn(p, 'sparkle', 1, rand)
  if (p.mood === 'dance' && p.tick % 8 === 0) spawn(p, 'note', 1, rand)
  if (p.mood === 'sleep' && p.tick % 20 === 0) spawn(p, 'z', 1, rand)

  p.particles = p.particles
    .map((q) => {
      const age = q.age + 1
      if (age <= 0) return { ...q, age }
      const rise = q.kind === 'sweat' ? 1 : q.kind === 'sparkle' ? 0 : -1
      const every = q.kind === 'z' ? 5 : 3
      return { ...q, age, y: age % every === 0 ? q.y + rise : q.y, x: q.kind === 'z' && age % 6 === 0 ? q.x + 1 : q.x }
    })
    .filter((q) => q.age < LIFE[q.kind])
}

// The original's 100 ms clock body: step, then expire the bubble ('zzz…' while asleep).
export function advance(p, rand = Math.random) {
  step(p, rand)
  if (p.bubbleUntil && p.tick >= p.bubbleUntil) {
    p.bubbleUntil = 0
    p.bubble = p.mood === 'sleep' ? 'zzz…' : ''
  }
  if (p.mood === 'sleep' && p.bubble === '') p.bubble = 'zzz…'
}

export function setMood(p, mood, ticks = 0) {
  p.mood = mood
  p.moodUntil = ticks ? p.tick + ticks : 0
}

// Says something in the bubble. Routine chatter (tool calls) is throttled: dropped when anything
// was said in the last 12 ticks. Returns whether it was said.
export function say(p, text, seconds = 4, isChatter = false) {
  if (isChatter && p.tick - p.bubbleAt < 12) return false
  p.bubbleAt = p.tick
  p.bubbleUntil = p.tick + (seconds * 1000) / TICK_MS
  p.bubble = text
  return true
}

export function wake(p, rand = Math.random) {
  p.lastActive = p.tick
  if (p.mood === 'sleep') {
    setMood(p, 'idle')
    p.particles = p.particles.filter((q) => q.kind !== 'z')
    say(p, pick(QUIPS.wake, rand))
  }
}

// The original keyed this on Claude's tool names (Edit/Write/NotebookEdit, Read, Bash, Grep/Glob,
// WebSearch/WebFetch, Agent/Task, TodoWrite); the core's toolKind() maps every agent's names to
// these kinds. The label is a file name (or a command line), never more.
export function toolLine(kind, label) {
  switch (kind) {
    case 'edit':
      return `✏️  ${clip(base(label), 28)}`
    case 'read':
      return `👀 ${clip(base(label), 28)}`
    case 'shell':
      return `⌨️  ${clip(String(label ?? '').split('\n')[0], 28)}`
    case 'search':
      return '🔎 searching…'
    case 'web':
      return '🌐 browsing…'
    case 'agent':
      return '🐙 calling in a helper'
    case 'todo':
      return '📝 making a plan'
    default:
      return null
  }
}

// The /clawd command (register.tsx:411-462) as a pure function of the current look
// { hat, shades, hidden, pinned }. Returns the reply text and the next look; the caller saves it and
// tells the renderer, which plays the animation with playCommand().
export function clawdCommand(input, look, rand = Math.random) {
  const [verb = '', ...rest] = String(input ?? '').trim().toLowerCase().split(/\s+/)
  const arg = rest.join(' ')
  const next = { ...look }
  const done = (text, ok = true) => ({ verb, arg, ok, next, text })

  if (verb === 'hat') {
    if (arg === 'random') {
      next.pinned = null
      next.hat = randomHat(rand, look.hat)
      return done(`Clawd put on the ${next.hat}. A new random hat every session from now on.`)
    }
    const name = arg || WEARABLE[(WEARABLE.indexOf(look.hat) + 1) % WEARABLE.length]
    if (!validHat(name)) return done(`No hat called "${arg}". Hats: ${WEARABLE.join(', ')}`, false)
    next.hat = name
    next.pinned = name
    return done(`Clawd is wearing the ${name}, and will keep it on. /clawd hat random goes back to a new hat each session.`)
  }
  if (verb === 'hats') return done(`Hats: ${WEARABLE.join(', ')}. Wearing: ${look.hat}.`)
  if (verb === 'pet') return done('You pet Clawd. ♥')
  if (verb === 'dance') return done('Clawd dances.')
  if (verb === 'party') return done('Party time.')
  if (verb === 'shades') {
    next.shades = !look.shades
    return done(next.shades ? 'Shades on.' : 'Shades off.')
  }
  if (verb === 'hide' || verb === 'show') {
    next.hidden = verb === 'hide'
    return done(next.hidden ? 'Clawd is hiding. /clawd show brings Clawd back.' : 'Clawd is back.')
  }
  return done(`Clawd is wearing the ${look.hat}${look.shades ? ' and shades' : ''}. ${HELP}`)
}

// What a /clawd command does to one pet on screen. cmd: { verb, arg, ok, hat, shades }.
export function playCommand(p, cmd, rand = Math.random) {
  wake(p, rand)
  const { verb, arg, ok, hat, shades } = cmd
  if (verb === 'hat') {
    if (ok === false || !validHat(hat)) return
    p.hat = hat
    if (arg === 'random') {
      say(p, `ooh, ${hat}!`)
      return
    }
    spawn(p, 'sparkle', 3, rand)
    say(p, `how do I look? (${hat})`)
  } else if (verb === 'pet') {
    spawn(p, 'heart', 4, rand)
    say(p, pick(QUIPS.pet, rand))
  } else if (verb === 'dance') {
    setMood(p, 'dance', 60)
    say(p, '♪ ♫ ♪', 6)
  } else if (verb === 'party') {
    p.partyHat = true
    setMood(p, 'party', 40)
    spawn(p, 'sparkle', 6, rand)
    say(p, '🎉 party!')
  } else if (verb === 'shades' && typeof shades === 'boolean') {
    p.shades = shades
    say(p, shades ? 'deal with it 😎' : 'ok, shades off')
  }
}
