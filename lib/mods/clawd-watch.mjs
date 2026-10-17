// The Clawd renderer behind `agent-mods clawd watch`. It follows today's event log (the clawd hooks
// append to it), keeps one pet per live session of any agent, steps every pet on one 100 ms timer and
// redraws them all from the top-left with 24-bit ANSI half blocks.
//
// The world (createWorld, reduce, seedWorld, tickWorld, applyPrefs) lives in clawd-world.mjs, which
// the dashboard page imports as is; it is re-exported here. The world and composeRows are pure: no
// files, no terminal, and the clock and randomness come in as arguments, so tests drive the whole
// pane without a TTY. createFollower (the log reader) and startWatch (the draw loop) are the only
// parts with I/O.
import fs from 'node:fs'
import {
  MAX_W,
  RESET,
  ROWS,
  SPRITE_W,
  TICK_MS,
  ansiLines,
  frame,
} from './clawd-sprite.mjs'
import {
  BIG_TURN_MS,
  SILENCE_MS,
  applyPrefs,
  createWorld,
  isEvent,
  reduce,
  seedWorld,
  tickWorld,
} from './clawd-world.mjs'
import { EVENTS_DIR, PREFS_FILE, eventRel, readPrefs, sessionHat } from './clawd.mjs'

// Callers and tests that import the world from the pane keep working.
export { BIG_TURN_MS, SILENCE_MS, applyPrefs, createWorld, reduce, seedWorld, tickWorld }

const POLL_TICKS = 500 / TICK_MS
const SEED_BYTES = 512 * 1024
const TEXT_ROOM = 34 // the original's cap on the bubble's width beside the sprite

const CLAY = '\x1b[38;2;215;119;87m'
const DIM = '\x1b[2m'

// The sprite gets what the terminal can spare after the text beside it, between 12 and 30 columns.
export function spriteWidth(columns) {
  return Math.max(SPRITE_W, Math.min(MAX_W, (Number(columns) || 80) - 2 - TEXT_ROOM))
}

// Terminal text: control and bidi characters out (log lines are data), and widths counted the way a
// terminal draws them. Emoji count as two columns, which can only overestimate: the text is the last
// thing on its line, so a wrong guess shortens it instead of wrapping the pane.
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g
const ZERO_WIDTH = /^[̀-ͯ​-‏⃐-⃿︀-️]$/u
const WIDE = /^(?:\p{Extended_Pictographic}|[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f000}-\u{1faff}\u{20000}-\u{3fffd}])$/u

export function printable(text) {
  return String(text ?? '').replace(UNPRINTABLE, '')
}

const charWidth = (ch) => (ZERO_WIDTH.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1)

export function textWidth(text) {
  let width = 0
  for (const ch of String(text)) width += charWidth(ch)
  return width
}

export function fitText(text, columns) {
  if (textWidth(text) <= columns) return text
  let out = ''
  let width = 0
  for (const ch of String(text)) {
    const w = charWidth(ch)
    if (width + w > columns - 1) break
    out += ch
    width += w
  }
  return columns > 0 ? `${out}…` : ''
}

// One pet: the sprite, then (one column on) who it is and what it is saying, beside the head, and
// its project with the lasting 'waiting' tag beneath. Clawd's home corner faces the bubble.
function petRows(en, columns) {
  const sprite = ansiLines(frame(en.pet))
  const room = columns - en.pet.width - 2
  if (room < 3) return sprite
  const who = printable(en.agent)
  const said = printable(en.pet.bubble)
  const talk = fitText(said ? `‹ ${who} ${said}` : `  ${who}`, room)
  const where = fitText(`  ${printable(en.project)}${en.waiting ? ' · waiting' : ''}`, room)
  const text = ['', `${CLAY}${talk}${RESET}`, `${DIM}${where}${RESET}`, '']
  return sprite.map((line, i) => (text[i] ? `${line} ${text[i]}` : line))
}

// The whole pane as lines, top to bottom. When the pets do not all fit, the most recently active
// ones are shown, still in the order they arrived.
export function composeRows(world, { columns = 80, rows = 24, scope = 'all projects' } = {}) {
  const width = Math.max(1, columns - 1)
  const note = (text) => `${DIM}${fitText(text, width)}${RESET}`
  const lines = [note(`clawd · ${printable(scope)} · ctrl+c quits`)]
  if (world.hidden) {
    lines.push(note('Clawd is hiding. /clawd show brings Clawd back.'))
    return lines
  }
  if (!world.pets.length) {
    lines.push(note('No sessions yet: a Clawd appears when an agent starts or does something.'))
    return lines
  }
  const fits = Math.max(1, Math.floor((rows - 2) / ROWS))
  let shown = world.pets
  if (shown.length > fits) {
    const keep = new Set([...shown].sort((a, b) => b.seenAt - a.seenAt).slice(0, fits).map((en) => en.sid))
    shown = shown.filter((en) => keep.has(en.sid))
  }
  for (const en of shown) lines.push(...petRows(en, columns))
  if (world.pets.length > shown.length) lines.push(note(`+${world.pets.length - shown.length} more (a taller pane shows them)`))
  return lines
}

export function parseEventLines(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event = JSON.parse(trimmed)
      if (isEvent(event)) out.push(event)
    } catch {}
  }
  return out
}

function fileSize(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return -1
  }
}

function readRange(file, start, end) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(Math.max(0, end - start))
    let got = 0
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, start + got)
      if (n <= 0) break
      got += n
    }
    return buf.subarray(0, got)
  } finally {
    fs.closeSync(fd)
  }
}

// Complete lines in the last SEED_BYTES of a file up to `end`; a cut first line is dropped.
function tailLines(file, end) {
  if (end <= 0) return { events: [], end: 0 }
  const from = Math.max(0, end - SEED_BYTES)
  const chunk = readRange(file, from, end)
  const complete = chunk.lastIndexOf(0x0a) + 1
  let text = chunk.subarray(0, complete).toString('utf8')
  if (from > 0) text = text.slice(text.indexOf('\n') + 1)
  return { events: parseEventLines(text), end: from + complete }
}

// Follows events/<today>.jsonl from its current end, reading only appended bytes. A half-written
// last line waits in `carry` until its newline arrives; at midnight the old file is drained before
// the new day's file is followed from its start.
export function createFollower(store, now = Date.now()) {
  let rel = eventRel(now)
  let file = store.path(rel)
  const today = tailLines(file, Math.max(0, fileSize(file)))
  let offset = today.end
  let carry = Buffer.alloc(0)
  let seed = today.events
  const earlier = eventRel(now - SILENCE_MS)
  if (earlier !== rel) seed = [...tailLines(store.path(earlier), Math.max(0, fileSize(store.path(earlier)))).events, ...seed]

  function drain() {
    const size = fileSize(file)
    if (size < 0) return []
    if (size < offset) {
      offset = 0
      carry = Buffer.alloc(0)
    }
    if (size === offset) return []
    const chunk = readRange(file, offset, size)
    offset += chunk.length
    const data = carry.length ? Buffer.concat([carry, chunk]) : chunk
    const end = data.lastIndexOf(0x0a)
    if (end < 0) {
      carry = Buffer.from(data)
      return []
    }
    carry = Buffer.from(data.subarray(end + 1))
    return parseEventLines(data.subarray(0, end).toString('utf8'))
  }

  return {
    seed: () => seed,
    file: () => file,
    read(at = Date.now()) {
      const next = eventRel(at)
      if (next === rel) return drain()
      const last = drain()
      rel = next
      file = store.path(rel)
      offset = 0
      carry = Buffer.alloc(0)
      return [...last, ...drain()]
    },
  }
}

function stampOf(file) {
  try {
    const stat = fs.statSync(file)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return ''
  }
}

const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'

// The live pane. Returns { stop, done, world }: done resolves with exit code 0 once stopped (ctrl+c
// when `signals` is on). The cursor is hidden while it runs and shown again however it ends.
export function startWatch({
  store,
  filter = null,
  scope = 'all projects',
  out = process.stdout,
  clock = Date.now,
  rand = Math.random,
  signals = true,
} = {}) {
  const hatOf = (sid) => sessionHat(store, sid)
  const columns = () => Number(out.columns) || 80
  const rows = () => Number(out.rows) || 24
  const prefsFile = store.path(PREFS_FILE)
  let prefsStamp = stampOf(prefsFile)
  let world = createWorld({ prefs: readPrefs(store), filter, width: spriteWidth(columns()) })
  const follower = createFollower(store, clock())
  world = seedWorld(world, follower.seed(), { now: clock(), rand, hatOf })

  const pull = () => {
    try {
      const now = clock()
      for (const e of follower.read(now)) world = reduce(world, e, { now, rand, hatOf })
      const stamp = stampOf(prefsFile)
      if (stamp !== prefsStamp) {
        prefsStamp = stamp
        world = applyPrefs(world, readPrefs(store))
      }
    } catch {}
  }

  // Each line is placed by cursor position (no reliance on newline handling) and nothing is written
  // when the screen is unchanged, which is most ticks once the pets are idle or asleep.
  let shown = ''
  const paint = () => {
    const lines = composeRows(world, { columns: columns(), rows: rows(), scope })
    let screen = ''
    lines.forEach((line, i) => {
      screen += `\x1b[${i + 1};1H${line}\x1b[K`
    })
    if (lines.length < rows()) screen += `\x1b[${lines.length + 1};1H\x1b[J`
    if (screen === shown) return
    shown = screen
    out.write(screen)
  }

  let watcher = null
  try {
    fs.mkdirSync(store.path(EVENTS_DIR), { recursive: true })
    watcher = fs.watch(store.path(EVENTS_DIR), () => pull())
    watcher.on('error', () => {
      watcher?.close()
      watcher = null
    })
  } catch {
    watcher = null
  }

  out.write(`${HIDE_CURSOR}\x1b[2J`)
  paint()
  let ticks = 0
  const timer = setInterval(() => {
    try {
      ticks += 1
      if (ticks % POLL_TICKS === 0) pull()
      world = tickWorld(world, { now: clock(), width: spriteWidth(columns()), rand })
      paint()
    } catch {}
  }, TICK_MS)

  let stopped = false
  let finish
  const done = new Promise((resolve) => {
    finish = resolve
  })
  const restore = () => out.write(`${RESET}${SHOW_CURSOR}\n`)
  const onExit = () => {
    if (!stopped) restore()
  }
  const onResize = () => {
    shown = ''
    out.write('\x1b[2J')
  }
  const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK']
  function stop() {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    watcher?.close()
    if (signals) for (const name of SIGNALS) process.off(name, stop)
    process.off('exit', onExit)
    if (typeof out.off === 'function') out.off('resize', onResize)
    restore()
    finish(0)
  }
  if (signals) for (const name of SIGNALS) process.on(name, stop)
  process.on('exit', onExit)
  if (typeof out.on === 'function') out.on('resize', onResize)
  return { stop, done, world: () => world }
}

export function watch(options) {
  return startWatch(options).done
}
