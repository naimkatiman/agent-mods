// agent-mods dashboard page: every agent session on this machine, live, from the local dashboard
// process. One EventSource brings the whole snapshot and the activity lines; this file renders them
// into index.html's skeleton and sends the page's actions back. Every node is made with
// createElement and filled with textContent, so anything the server sends is shown as text.
//
// Sections: helpers, preferences, time, server calls, state, pets, connection, header, needs-you
// dialog, session list (rows, details, resume commands, messages), rail and panels, keyboard, boot.
import { ASK_BUBBLE, PICKABLE_HATS, RECENT_MS, SLEEP_BUBBLE, createPets, hatWords } from './pets.js'

// ================================================================================================
// Helpers: element building, icons, text
// ================================================================================================

const SVG_NS = 'http://www.w3.org/2000/svg'
const byId = (id) => document.getElementById(id)

// Properties that are set on the element itself; every other name becomes an attribute. Listeners
// only go through `on`, and a style attribute is refused (the page's CSP forbids inline style).
const PROPS = new Set(['type', 'value', 'checked', 'disabled', 'maxLength', 'name', 'placeholder', 'autocomplete', 'readOnly', 'id', 'title'])

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (name === 'class') node.className = value
    else if (name === 'text') node.textContent = value
    else if (name === 'hidden') node.hidden = true
    else if (name === 'on') for (const [type, fn] of Object.entries(value)) node.addEventListener(type, fn)
    else if (name === 'data') for (const [k, v] of Object.entries(value)) node.dataset[k] = v
    else if (PROPS.has(name)) node[name] = value
    else if (name === 'style' || /^on/i.test(name)) throw new TypeError(`${name} is not set from script`)
    else node.setAttribute(name, value === true ? '' : String(value))
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) node.append(kid)
  return node
}

const ICONS = {
  copy: 'M5.5 5.5h8v8h-8z M2.5 10.5v-8h8',
  send: 'M2.5 8h9 M8 4.5 11.5 8 8 11.5',
}

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  for (const [k, v] of [['class', 'ic'], ['viewBox', '0 0 16 16'], ['width', '16'], ['height', '16'], ['aria-hidden', 'true'], ['focusable', 'false']]) svg.setAttribute(k, v)
  const path = document.createElementNS(SVG_NS, 'path')
  for (const [k, v] of [['d', ICONS[name]], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.4']]) path.setAttribute(k, v)
  svg.append(path)
  return svg
}

let uidCount = 0
const uid = (prefix) => `${prefix}-${++uidCount}`

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']
const countWord = (n) => COUNT_WORDS[n] ?? String(n)
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const baseName = (p) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''

function firstLine(text, max = 140) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .find((l) => l.trim())
  return line ? clip(line.trim(), max) : ''
}

// A path that may break after any separator, so a long one wraps instead of overflowing.
function pathCode(path, className) {
  const code = h('code', { class: className })
  for (const part of String(path ?? '').split(/(?<=[\\/])/)) code.append(part, h('wbr'))
  return code
}

// Says something to screen readers once, through the page's polite live region.
function announce(text) {
  const region = byId('announce')
  region.textContent = ''
  window.setTimeout(() => {
    region.textContent = text
  }, 60)
}

// Swaps a button's label for a moment ("Copied...") and back.
const idleLabels = new WeakMap()
const flashTimers = new WeakMap()
function flash(button, text, ms = 2600) {
  const label = button.querySelector('.lbl') ?? button
  if (!idleLabels.has(button)) idleLabels.set(button, label.textContent)
  label.textContent = text
  window.clearTimeout(flashTimers.get(button))
  flashTimers.set(
    button,
    window.setTimeout(() => {
      flashTimers.delete(button)
      label.textContent = idleLabels.get(button)
    }, ms),
  )
}

// A button's resting label; one that is flashing shows it when the flash ends.
function setLabel(button, text) {
  idleLabels.set(button, text)
  if (!flashTimers.has(button)) (button.querySelector('.lbl') ?? button).textContent = text
}

// The clipboard API first; a selected hidden textarea when the browser refuses it, or when it has
// not answered in CLIPBOARD_WAIT_MS (a permission prompt left open keeps it pending for good).
const CLIPBOARD_WAIT_MS = 1500

async function copyText(text) {
  try {
    const gaveUp = new Promise((resolve, reject) => {
      window.setTimeout(() => reject(new Error('the clipboard did not answer')), CLIPBOARD_WAIT_MS)
    })
    await Promise.race([navigator.clipboard.writeText(text), gaveUp])
    return true
  } catch {}
  try {
    const area = h('textarea', { class: 'vh', 'aria-hidden': 'true', tabindex: '-1' })
    area.value = text
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}

// ================================================================================================
// Preferences: per viewer, in this browser only, and never required for the page to work
// ================================================================================================

const store = {
  get(name, fallback = null) {
    try {
      const value = window.localStorage.getItem(`agent-mods.dashboard.${name}`)
      return value === null ? fallback : value
    } catch {
      return fallback
    }
  },
  set(name, value) {
    try {
      window.localStorage.setItem(`agent-mods.dashboard.${name}`, String(value))
    } catch {}
  },
}

const SHELLS = [
  ['powershell', 'PowerShell'],
  ['bash', 'Git Bash'],
  ['cmd', 'cmd'],
]
const SHELL_NAMES = Object.fromEntries(SHELLS)
const PANELS = ['assumptions', 'ideas', 'rules', 'decisions', 'messages', 'activity', 'health', 'settings']

const prefs = {
  shell: SHELL_NAMES[store.get('shell')] ? store.get('shell') : 'powershell',
  showEnded: store.get('showEnded') === '1',
  scope: store.get('scope', 'all'),
  notify: store.get('notify') === '1',
  sound: store.get('sound') === '1',
  panel: PANELS.includes(store.get('panel')) ? store.get('panel') : '',
}

// ================================================================================================
// Time: the server stamps everything in its clock; the page corrects for the difference
// ================================================================================================

// Each snapshot gives one sample, its `at` minus the time it arrived: the true skew minus however
// long it took to arrive (the server holds pushes up to a second and answers a new connection with
// a snapshot up to two seconds old). Delays only lower a sample, so the largest one this connection
// has seen is the best estimate; a new connection starts over.
let skew = 0
let skewSamples = 0
const serverNow = () => Date.now() + skew

function sampleSkew(at) {
  if (!Number.isFinite(at)) return
  const sample = at - Date.now()
  skew = skewSamples ? Math.max(skew, sample) : sample
  skewSamples += 1
}

function short(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}

const ago = (at) => short(serverNow() - at)

function agoWords(at) {
  const s = Math.max(0, Math.floor((serverNow() - at) / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s} s ago`
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86_400)} d ago`
}

// Text that says how long ago something was, kept current by the one-second ticker.
const liveTexts = new Map()
function liveText(node, at, format) {
  liveTexts.set(node, { at, format })
  const text = format(at)
  if (node.textContent !== text) node.textContent = text
  return node
}

function tickTexts() {
  for (const [node, { at, format }] of liveTexts) {
    if (!node.isConnected) {
      liveTexts.delete(node)
      continue
    }
    const text = format(at)
    if (node.textContent !== text) node.textContent = text
  }
}

// ================================================================================================
// Server calls: every failure becomes a sentence for the place it happened
// ================================================================================================

const KEY_GONE = "This page's key is missing or expired. Run agent-mods dashboard to open it again."
const ORIGIN_REFUSED = 'The dashboard refused this action: it did not come from the dashboard page itself (the Origin check failed). Open the page again with agent-mods dashboard.'
const NO_ANSWER = 'The dashboard process did not answer. If it stopped, run agent-mods dashboard in a terminal.'

async function call(path, init = {}) {
  let res
  try {
    res = await fetch(path, { cache: 'no-store', credentials: 'same-origin', ...init })
  } catch {
    return { ok: false, status: 0, text: NO_ANSWER, body: null }
  }
  let body = null
  try {
    body = await res.json()
  } catch {}
  const text = body && typeof body.text === 'string' ? body.text : ''
  if (res.status === 401) {
    setConn('locked')
    return { ok: false, status: 401, text: KEY_GONE, body }
  }
  if (res.status === 403 && init.method === 'POST') return { ok: false, status: 403, text: ORIGIN_REFUSED, body }
  if (!res.ok) return { ok: false, status: res.status, text: text || `The dashboard answered ${res.status}. Try again.`, body }
  return { ok: true, status: res.status, text, body }
}

function act(type, fields) {
  return call('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, ...fields }) })
}

// ================================================================================================
// State
// ================================================================================================

const MAX_FEED = 200
const SILENT_MS = 15 * 60_000
const STALE_MS = 5 * 60_000
const DONE_SHOWN = 8
// The activity lines a reconnect can repeat are the server's replay buffer (at most 400): twice that
// many recent signatures catch every repeat, however busy the machine is.
const SEEN_MAX = 800

const state = {
  snap: null,
  sessions: [],
  byKey: new Map(),
  projects: new Map(),
  waiting: null, // waiting keys of the previous snapshot; null until the first one
  states: new Map(), // key -> state in the previous snapshot
  fresh: new Map(), // key -> when the page saw that turn finish
  expanded: new Set(),
  lastExpanded: null,
  showAllDone: false,
  activity: [], // newest last
  seen: new Set(), // the last SEEN_MAX line signatures, oldest first, so a reconnect does not repeat lines
}

const AGENT_SHORT = { claude: 'Claude', codex: 'Codex', grok: 'Grok', devin: 'Devin' }
const HOME_DIRS = { claude: '.claude', codex: '.codex', grok: '.grok', devin: '.devin' }
const SPEAKERS = { dashboard: 'You, from the dashboard', cli: 'You, from the CLI' }

const titleOf = (s) => (s.name && String(s.name).trim()) || String(s.id ?? '').slice(0, 8) || 'A session'
const projectOf = (s) => (s.projectId && state.projects.get(s.projectId)) || null
const repoOf = (s) => projectOf(s)?.name ?? s.project ?? ''
const scopeKeyOf = (s) => s.projectId || `folder:${s.project ?? ''}`
const inScope = (s) => prefs.scope === 'all' || scopeKeyOf(s) === prefs.scope

// "default Claude home", or "Claude home 92" for a home in another folder.
function homeLabel(s) {
  const who = AGENT_SHORT[s.agent] ?? s.agentLabel ?? 'agent'
  const leaf = baseName(s.home)
  if (!leaf || leaf.toLowerCase() === HOME_DIRS[s.agent]) return `default ${who} home`
  return `${who} home ${leaf}`
}

// The needs-you headline, from what the session is waiting for.
function headline(s) {
  const title = titleOf(s)
  const reason = String(s.waitingFor ?? '').trim()
  const approve = /^approve\s+(.+)$/i.exec(reason)
  if (approve) return `${title} needs your OK to run ${approve[1]}`
  if (reason) return `${title} is waiting: ${reason}`
  return `${title} is waiting for you`
}

function reasonOf(s) {
  const reason = String(s.waitingFor ?? '').trim()
  const approve = /^approve\s+(.+)$/i.exec(reason)
  if (approve) return `Needs your OK to run ${approve[1]}`
  return reason || 'Waiting for you'
}

// One line for a finished turn: what it says it did, else the start of its answer.
function outcome(s, fallback = 'Turn finished') {
  if (s.done) return s.done
  const answer = firstLine(s.answer)
  return answer || fallback
}

const TIME_WORDS = { working: 'active', idle: 'finished', open: 'opened', ended: 'ended', waiting: 'waiting' }
const timeWord = (s) => TIME_WORDS[s.state] ?? 'seen'

function deliveryText(s) {
  return s.agent === 'grok' ? 'Arrives with its next edit, or when it calls the briefing tool.' : 'Arrives with its next prompt.'
}

// ================================================================================================
// Pets
// ================================================================================================

const reducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
const pets = createPets({ clock: serverNow, reduced: Boolean(reducedMotion?.matches), onBubble: (key, text) => showBubble(key, text) })
reducedMotion?.addEventListener?.('change', (e) => pets.setReduced(e.matches))

// A list row shows what the pet says right now, but not its "zzz…" for the whole nap: the nightcap
// already says that. The expanded strip shows every bubble.
const rowBubble = (text) => (text === SLEEP_BUBBLE ? '' : text)

function showBubble(key, text) {
  const row = rowViews.get(key)
  if (row) {
    sayInRow(row, rowBubble(text))
    queueFit(row, { now: false })
  }
  const detail = detailViews.get(key)
  if (detail) detail.stripSay.textContent = text
}

function sayInRow(view, text) {
  if (view.say.textContent !== text) view.say.textContent = text
  view.say.hidden = !text || view.kind === 'ended' || view.kind === 'open'
}

// ================================================================================================
// Connection: live from the EventSource, never from a timer that pretends
// ================================================================================================

const PROBE_MS = 5000
const conn = { es: null, state: 'connecting', lostAt: 0, lastData: 0, seedNext: true, retry: null, probing: false }

function connect() {
  window.clearTimeout(conn.retry)
  if (conn.state === 'locked') return
  let es
  try {
    es = new EventSource('/events')
  } catch {
    conn.retry = window.setTimeout(connect, 3000)
    return
  }
  conn.es = es
  es.addEventListener('open', () => {
    if (conn.es !== es) return
    conn.seedNext = true
    skewSamples = 0
    setConn('live')
  })
  es.addEventListener('snapshot', (e) => {
    const snap = parse(e.data)
    if (snap) onSnapshot(snap)
  })
  es.addEventListener('activity', (e) => {
    const lines = parse(e.data)
    if (Array.isArray(lines)) onActivity(lines)
  })
  es.addEventListener('error', () => {
    if (conn.es !== es) return
    lost()
    // CLOSED: the browser gave up (an HTTP error such as 401). Find out why, then try again.
    if (es.readyState === EventSource.CLOSED) {
      es.close()
      diagnose()
    }
  })
}

function parse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function lost() {
  if (conn.state === 'locked' || conn.state === 'stopped') return
  if (conn.state !== 'reconnecting') conn.lostAt = Date.now()
  setConn('reconnecting')
  probeSoon()
}

async function diagnose() {
  const r = await call('/api/snapshot')
  if (r.status === 401) return
  if (r.ok && r.body) onSnapshot(r.body)
  conn.retry = window.setTimeout(connect, 3000)
}

// While the stream is down, /healthz says whether the process is there at all.
function probeSoon() {
  if (conn.probing) return
  conn.probing = true
  const step = async () => {
    if (conn.state === 'live' || conn.state === 'locked') {
      conn.probing = false
      return
    }
    let up = false
    try {
      const res = await fetch('/healthz', { cache: 'no-store' })
      up = res.ok
    } catch {}
    if (conn.state === 'live' || conn.state === 'locked') {
      conn.probing = false
      return
    }
    if (!up && Date.now() - conn.lostAt >= PROBE_MS) setConn('stopped')
    else if (up && conn.state === 'stopped') {
      setConn('reconnecting')
      if (!conn.es || conn.es.readyState === EventSource.CLOSED) connect()
    }
    window.setTimeout(step, PROBE_MS)
  }
  window.setTimeout(step, PROBE_MS)
}

const BANNERS = {
  reconnecting: 'Lost the connection to the local dashboard process. Retrying. If it stopped, run agent-mods dashboard in a terminal.',
  stopped: 'Stopped: the dashboard process is not running. Run agent-mods dashboard to start it again. The last data stays on the page, greyed.',
  locked: KEY_GONE,
}
const CONN_WORDS = { connecting: 'Connecting', live: 'Live', reconnecting: 'Reconnecting', stopped: 'Stopped', locked: 'Locked' }

// Only the state word sits in the live region (#conn-text): "last update 7s ago" beside it changes
// every second and would be read out every second.
function setConn(next) {
  if (conn.state === 'locked' && next !== 'locked') return
  const changed = conn.state !== next
  conn.state = next
  document.body.dataset.conn = next
  if (next === 'locked' && conn.es) conn.es.close()
  setText(byId('conn-text'), CONN_WORDS[next])
  const banner = byId('banner')
  banner.hidden = !BANNERS[next]
  setText(banner, BANNERS[next] ?? '')
  // Behind a full-screen panel the header is inert, so its alert is not read: say it here instead.
  if (changed && BANNERS[next] && isSheetOpen()) announce(BANNERS[next])
  pets.setFrozen(next !== 'live' && next !== 'connecting')
  tickConn()
  if (state.snap) renderTitle()
  measureTop()
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text
}

function tickConn() {
  let text = ''
  if (conn.state === 'live') text = 'checks every 2 s'
  else if (conn.lastData && conn.state !== 'connecting') text = `last update ${short(Date.now() - conn.lastData)} ago`
  setText(byId('conn-sub'), text)
}

// ================================================================================================
// Snapshot and activity in
// ================================================================================================

function onSnapshot(snap) {
  if (!snap || typeof snap !== 'object' || !Array.isArray(snap.sessions)) return
  sampleSkew(snap.at)
  conn.lastData = Date.now()
  byId('loading').hidden = true
  state.snap = snap
  state.sessions = snap.sessions.filter((s) => s && typeof s.key === 'string')
  state.byKey = new Map(state.sessions.map((s) => [s.key, s]))
  state.projects = new Map((Array.isArray(snap.projects) ? snap.projects : []).filter((p) => p && typeof p.id === 'string').map((p) => [p.id, p]))
  for (const key of [...state.expanded]) if (!state.byKey.has(key)) state.expanded.delete(key)

  // A turn the page saw finish gets a short flash on its row.
  for (const [key, at] of state.fresh) if (Date.now() - at > 5000) state.fresh.delete(key)
  for (const s of state.sessions) {
    const before = state.states.get(s.key)
    if (before === 'working' && s.state === 'idle') state.fresh.set(s.key, Date.now())
  }
  state.states = new Map(state.sessions.map((s) => [s.key, s.state]))

  pets.sync(state.sessions, snap.settings?.clawd ?? {})
  const arrived = newlyWaiting()
  render()
  if (arrived.length) arrive(arrived)
}

function lineSig(l) {
  return [l.t, l.key, l.ev, l.kind, l.label, l.verb, l.arg, l.ok].join('|')
}

function onActivity(lines) {
  const seeding = conn.seedNext
  conn.seedNext = false
  conn.lastData = Date.now()
  const fresh = []
  for (const line of lines) {
    if (!line || typeof line !== 'object' || !Number.isFinite(line.t) || typeof line.ev !== 'string') continue
    const sig = lineSig(line)
    if (state.seen.has(sig)) continue
    state.seen.add(sig)
    if (state.seen.size > SEEN_MAX) state.seen.delete(state.seen.values().next().value)
    fresh.push(line)
  }
  if (seeding) pets.seed(fresh)
  else pets.feed(fresh)
  if (!fresh.length) return
  state.activity = [...state.activity, ...fresh].sort((a, b) => a.t - b.t).slice(-MAX_FEED)
  renderRailActivity()
  if (openPanelName === 'activity') renderActivity()
}

// ================================================================================================
// Header: running count, scope, tally, title, favicon, alert toggles
// ================================================================================================

const FAVICON = 'favicon.svg'
const FAVICON_NEEDS = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect width="16" height="16" rx="3" fill="#0c0c0c"/><g fill="#d77757"><rect x="4" y="6" width="8" height="4"/><rect x="2" y="8" width="2" height="1"/><rect x="12" y="8" width="2" height="1"/><rect x="4" y="10" width="1" height="2"/><rect x="6" y="10" width="1" height="2"/><rect x="9" y="10" width="1" height="2"/><rect x="11" y="10" width="1" height="2"/></g><rect x="5" y="7" width="1" height="1" fill="#000"/><rect x="10" y="7" width="1" height="1" fill="#000"/><rect x="9" y="0" width="7" height="5" fill="#ffd23f"/></svg>',
)}`

let tallySig = ''
let scopeSig = ''
let lastNeedsCount = null

// The tally counts what the list shows (the folder filter applies), except "needs you": that one
// covers every folder, like the dialog it points at.
function renderHeader() {
  const all = state.sessions.filter((s) => s.state !== 'ended')
  const scoped = all.filter(inScope)
  const count = (list, st) => list.filter((s) => s.state === st).length
  const needs = count(all, 'waiting')
  const filtered = prefs.scope !== 'all'
  byId('running').textContent = filtered ? `${scoped.length} of ${all.length} running ·` : `${all.length} running ·`

  const chips = [
    ['t-need', '#needs', '?', needs, 'needs you'],
    ['', '#working', '●', count(scoped, 'working'), 'working'],
    ['', '#done', '✓', count(scoped, 'idle'), 'done'],
    ['', '#open', '◇', count(scoped, 'open'), 'open'],
  ].filter(([, , , n]) => n > 0)
  const sig = JSON.stringify([chips, prefs.scope])
  if (sig !== tallySig) {
    tallySig = sig
    const tally = byId('tally')
    tally.setAttribute('aria-label', filtered ? `Session counts in ${scopeName()}; needs you covers every folder` : 'Session counts')
    tally.replaceChildren(
      ...chips.map(([cls, href, glyph, n, word]) =>
        h('a', { class: cls || null, href, title: filtered && cls ? 'Every folder' : null }, h('span', { 'aria-hidden': 'true', text: glyph }), `${n} ${word}`),
      ),
    )
  }

  renderTitle()
  const link = byId('favicon')
  const href = needs > 0 ? FAVICON_NEEDS : FAVICON
  if (link.getAttribute('href') !== href) link.setAttribute('href', href)

  if (lastNeedsCount !== null && needs !== lastNeedsCount) {
    announce(needs === 0 ? 'Nothing needs you now.' : `${plural(needs, 'session needs', 'sessions need')} you.`)
  }
  lastNeedsCount = needs
  renderScope(all)
}

// While the data is stale (reconnecting, stopped, locked), the tab title says so first.
function renderTitle() {
  const all = state.sessions.filter((s) => s.state !== 'ended')
  const needs = all.filter((s) => s.state === 'waiting').length
  const base = needs > 0 ? `(${needs}) needs you · agent-mods` : `agent-mods · ${all.length} running`
  const live = conn.state === 'live' || conn.state === 'connecting'
  document.title = live ? base : `${CONN_WORDS[conn.state]} · ${base}`
}

function renderScope(all) {
  const options = new Map()
  for (const s of all) {
    const key = scopeKeyOf(s)
    const entry = options.get(key) ?? { name: repoOf(s) || 'a folder', n: 0 }
    entry.n += 1
    options.set(key, entry)
  }
  if (prefs.scope !== 'all' && !options.has(prefs.scope)) {
    const project = state.projects.get(prefs.scope)
    if (project) options.set(prefs.scope, { name: project.name, n: 0 })
    else setScope('all', false)
  }
  const list = [...options].sort((a, b) => a[1].name.localeCompare(b[1].name, undefined, { sensitivity: 'base' }))
  const sig = JSON.stringify([prefs.scope, list])
  if (sig === scopeSig) return
  scopeSig = sig
  const select = byId('scope')
  select.replaceChildren(
    h('option', { value: 'all', text: 'every folder' }),
    ...list.map(([value, { name, n }]) => h('option', { value, text: n ? name : `${name} (none running)` })),
  )
  select.value = prefs.scope
}

function setScope(value, again = true) {
  prefs.scope = value
  store.set('scope', value)
  scopeSig = ''
  if (again) render()
}

// Browser notifications and the sound: opt-in, remembered here, and only for "needs you".
let sound = null

function toolNote(text) {
  const note = byId('tool-note')
  note.textContent = text
  note.hidden = !text
  measureTop()
  window.clearTimeout(toolNote.timer)
  if (text)
    toolNote.timer = window.setTimeout(() => {
      note.hidden = true
      measureTop()
    }, 7000)
}

// soundBlocked: sound is on, but the browser refused the last play (no click on the page yet).
let soundBlocked = false
const SOUND_BLOCKED = 'Sound is on but the browser blocked it. Click anywhere on the page once.'

function renderTools() {
  byId('t-notify').setAttribute('aria-pressed', String(prefs.notify))
  const button = byId('t-sound')
  const blocked = prefs.sound && soundBlocked
  button.setAttribute('aria-pressed', String(prefs.sound))
  button.classList.toggle('is-blocked', blocked)
  button.title = blocked ? SOUND_BLOCKED : 'Play a sound when a session newly needs you'
}

function setSoundBlocked(on) {
  if (soundBlocked === on) return
  soundBlocked = on
  renderTools()
}

async function toggleNotify() {
  if (prefs.notify) {
    prefs.notify = false
    store.set('notify', '0')
    renderTools()
    toolNote('Alerts off.')
    return
  }
  let permission = 'denied'
  try {
    if (!('Notification' in window)) {
      toolNote('This browser cannot show notifications.')
      return
    }
    permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
  } catch {
    permission = 'denied'
  }
  if (permission !== 'granted') {
    toolNote('Notifications are blocked for this page. Allow them in the browser site settings, then turn Alerts on again.')
    return
  }
  prefs.notify = true
  store.set('notify', '1')
  renderTools()
  toolNote('Alerts on: a notification when a session newly needs you. Finished turns stay with the Windows toast.')
}

function soundPlayer() {
  if (!sound) {
    try {
      sound = new Audio('/done.wav')
    } catch {
      sound = null
    }
  }
  return sound
}

async function playSound() {
  const audio = soundPlayer()
  if (!audio) return false
  try {
    audio.currentTime = 0
    await audio.play()
    setSoundBlocked(false)
    return true
  } catch {
    return false
  }
}

async function toggleSound() {
  if (prefs.sound) {
    prefs.sound = false
    store.set('sound', '0')
    setSoundBlocked(false)
    renderTools()
    toolNote('Sound off.')
    return
  }
  // This click is what lets the browser play it later.
  const ok = await playSound()
  prefs.sound = true
  store.set('sound', '1')
  setSoundBlocked(!ok)
  renderTools()
  toolNote(ok ? 'Sound on: this plays when a session newly needs you.' : 'Sound on, but the browser blocked the test sound. Click anywhere on the page once so it can play.')
}

// Sound came back on from an earlier visit: the browser blocks it until the page gets a click or a
// key press, so the first one plays it once, muted, which unlocks it for the alerts.
function unlockSoundOnFirstGesture() {
  const unlock = async () => {
    window.removeEventListener('pointerdown', unlock, true)
    window.removeEventListener('keydown', unlock, true)
    const audio = soundPlayer()
    if (!audio) return
    try {
      audio.muted = true
      await audio.play()
      audio.pause()
      audio.currentTime = 0
      setSoundBlocked(false)
    } catch {
    } finally {
      audio.muted = false
    }
  }
  window.addEventListener('pointerdown', unlock, true)
  window.addEventListener('keydown', unlock, true)
}

// ================================================================================================
// Needs-you dialog
// ================================================================================================

function newlyWaiting() {
  const now = state.sessions.filter((s) => s.state === 'waiting')
  const keys = new Set(now.map((s) => s.key))
  const before = state.waiting
  state.waiting = keys
  if (!before) return []
  return now.filter((s) => !before.has(s.key))
}

// A session newly needs you: the frame flashes and the followspot fades on again, once.
function arrive(list) {
  restartAnimation(needs.frame, 'is-arriving', 1200)
  restartAnimation(needs.speaker, 'is-lit', 1300)
  for (const s of list) {
    const row = needs.rows.get(s.key)
    if (row) restartAnimation(row.li, 'is-new', 1300)
    alertFor(s)
  }
}

function restartAnimation(node, className, ms) {
  node.classList.remove(className)
  void node.offsetWidth
  node.classList.add(className)
  window.setTimeout(() => node.classList.remove(className), ms)
}

function alertFor(s) {
  if (prefs.notify) {
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        const body = `${reasonOf(s)} · ${s.agentLabel ?? 'An agent'} in ${repoOf(s) || 'a folder'}`
        new Notification(`${titleOf(s)} needs you`, { body, tag: `agent-mods-${s.key}` })
      }
    } catch {}
  }
  if (prefs.sound) {
    playSound().then((ok) => {
      if (ok) return
      setSoundBlocked(true)
      toolNote(SOUND_BLOCKED)
    })
  }
}

const needs = (() => {
  const section = byId('needs')
  const spot = h('div', { class: 'spot', 'aria-hidden': 'true' }, h('i', { class: 'spot-cone' }), h('i', { class: 'spot-pool' }))
  const bubble = h('p', { class: 'bubble', 'aria-hidden': 'true' }, h('span', { text: ASK_BUBBLE }))
  const petSlot = h('span', { class: 'pet-slot' })
  const speaker = h('div', { class: 'speaker' }, spot, bubble, petSlot)
  const wait = h('span', { class: 'ask-wait' })
  const label = h('p', { class: 'ask-label' }, h('span', { class: 'ask-g', 'aria-hidden': 'true', text: '?' }), h('span', { text: 'Needs you' }), wait)
  const q = h('h2', { class: 'ask-q', id: 'needs-q' })
  const why = h('p', { class: 'ask-why' })
  const scopeNote = h('p', { class: 'ask-scope', hidden: true })
  const show = h('button', { type: 'button', class: 'btn btn-signal', 'aria-expanded': 'false' }, h('span', { class: 'lbl', text: 'Show details' }))
  const copy = h('button', { type: 'button', class: 'btn btn-console' }, icon('copy'), h('span', { class: 'lbl', text: 'Copy resume command' }))
  const status = h('span', { class: 'ask-status', role: 'status' })
  const ask = h('div', { class: 'ask' }, label, q, why, scopeNote, h('div', { class: 'ask-acts' }, show, copy, status))
  const more = h('ol', { class: 'ask-more', 'aria-label': 'Also waiting for you', hidden: true })
  const inner = h('div', { class: 'dialog-in' }, h('div', { class: 'ask-main' }, speaker, ask), more)
  const frame = h('div', { class: 'dialog' }, inner)
  const details = h('div', { class: 'needs-details' })
  section.append(frame, details)
  show.addEventListener('click', () => needs.key && toggle(needs.key))
  copy.addEventListener('click', () => {
    const s = state.byKey.get(needs.key)
    if (s) copyResume(s, copy, status)
  })
  return { section, frame, speaker, petSlot, wait, q, why, scopeNote, show, copy, status, more, details, key: null, tileId: null, rows: new Map() }
})()

function renderNeeds() {
  const waiting = state.sessions.filter((s) => s.state === 'waiting').sort((a, b) => a.since - b.since || a.key.localeCompare(b.key))
  const live = state.sessions.filter((s) => s.state !== 'ended')
  needs.section.hidden = !waiting.length
  renderCalm(waiting.length === 0 && live.length > 0, live)
  renderEmpty(live.length === 0 && Boolean(state.snap))
  if (!waiting.length) {
    if (needs.tileId) pets.release(needs.tileId)
    needs.key = null
    needs.tileId = null
    return
  }
  const head = waiting[0]
  if (needs.key !== head.key) {
    if (needs.tileId) pets.release(needs.tileId)
    needs.key = head.key
    needs.tileId = `need:${head.key}`
    needs.petSlot.replaceChildren(pets.tile(needs.tileId, head.key, 'xl'))
  }
  liveText(needs.wait, head.since, (at) => `waiting ${ago(at)}`)
  needs.q.textContent = headline(head)
  const approve = /^approve\s/i.test(String(head.waitingFor ?? '').trim())
  if (head.alive) {
    needs.why.replaceChildren(
      h('strong', { text: `Answer it in its terminal: ${head.agentLabel} in ${head.project || repoOf(head)}, ${homeLabel(head)}.` }),
      ' ',
      approve ? 'A message cannot answer a permission prompt.' : 'A message cannot answer it: messages arrive with its next prompt.',
      ' Window closed? Copy the resume command into a new terminal.',
    )
    needs.show.className = 'btn btn-signal'
    needs.copy.className = 'btn btn-console'
  } else {
    needs.why.replaceChildren(
      h('strong', { text: `${head.agentLabel} in ${head.project || repoOf(head)} is not running anymore.` }),
      ' Paste the resume command into a terminal to pick it up there.',
    )
    needs.show.className = 'btn btn-console'
    needs.copy.className = 'btn btn-signal'
  }
  const filtered = prefs.scope !== 'all'
  needs.scopeNote.hidden = !filtered
  if (filtered) {
    const outside = waiting.filter((s) => !inScope(s)).length
    needs.scopeNote.textContent = `This covers every folder, not only ${scopeName()}${outside ? `: ${outside} of ${waiting.length} are elsewhere` : ''}. The folder filter applies to the list below.`
  }
  const open = state.expanded.has(head.key)
  needs.show.setAttribute('aria-expanded', String(open))
  needs.show.setAttribute('aria-controls', detailId(head.key))
  setLabel(needs.show, open ? 'Hide details' : 'Show details')

  // The others, one line each, inside the same frame.
  const rest = waiting.slice(1)
  needs.more.hidden = !rest.length
  const keep = new Set(rest.map((s) => s.key))
  for (const [key, row] of needs.rows) {
    if (!keep.has(key)) {
      row.li.remove()
      pets.release(row.tileId)
      needs.rows.delete(key)
    }
  }
  rest.forEach((s, i) => {
    let row = needs.rows.get(s.key)
    if (!row) {
      row = makeAskRow(s.key)
      needs.rows.set(s.key, row)
    }
    row.t.textContent = titleOf(s)
    row.r.textContent = reasonOf(s)
    row.r.title = String(s.waitingFor ?? '')
    liveText(row.w, s.since, (at) => `waiting ${ago(at)}`)
    const isOpen = state.expanded.has(s.key)
    row.show.setAttribute('aria-expanded', String(isOpen))
    row.show.setAttribute('aria-controls', detailId(s.key))
    setLabel(row.show, isOpen ? 'Hide details' : 'Show details')
    if (needs.more.children[i] !== row.li) needs.more.insertBefore(row.li, needs.more.children[i] ?? null)
  })

  // Details of waiting sessions open under the frame, in the same order.
  waiting.forEach((s) => {
    if (!state.expanded.has(s.key)) return
    const detail = detailFor(s.key)
    if (detail.root.parentNode !== needs.details) needs.details.append(detail.root)
  })
}

// One more session that needs you: its own small pet asking "your call" (its label says it needs
// you), the line, and its own status line for what its buttons did.
function makeAskRow(key) {
  const tileId = `ask:${key}`
  const t = h('span', { class: 'ask-row-t' })
  const r = h('span', { class: 'ask-row-r' })
  const w = h('span', { class: 'ask-row-w' })
  const show = h('button', { type: 'button', class: 'btn btn-console', 'aria-expanded': 'false' }, h('span', { class: 'lbl', text: 'Show details' }))
  const copy = h('button', { type: 'button', class: 'btn btn-console' }, icon('copy'), h('span', { class: 'lbl', text: 'Copy resume command' }))
  const status = h('span', { class: 'ask-status ask-row-status', role: 'status' })
  const li = h('li', { class: 'ask-row' }, pets.tile(tileId, key, 'done', 'tile-ask'), t, r, w, h('span', { class: 'ask-row-acts' }, show, copy), status)
  show.addEventListener('click', () => toggle(key))
  copy.addEventListener('click', () => {
    const s = state.byKey.get(key)
    if (s) copyResume(s, copy, status)
  })
  return { li, t, r, w, show, copy, tileId }
}

const calm = { tileId: null }

function renderCalm(on, live) {
  const box = byId('needs-none')
  box.hidden = !on
  if (!on) return
  if (!calm.tileId) {
    calm.tileId = 'calm'
    const text = h('p', {}, h('strong', { text: 'Nothing needs you.' }), ' ', h('span', { class: 'calm-sub' }))
    box.replaceChildren(pets.free(calm.tileId, { hat: 'tophat', mood: 'sleep' }), text)
  }
  const working = live.filter((s) => s.state === 'working').length
  const done = live.filter((s) => s.state === 'idle').length
  const parts = []
  if (working) parts.push(`${plural(working, 'session is', 'sessions are')} working`)
  if (done) parts.push(`${done} ${done === 1 ? 'is' : 'are'} done`)
  box.querySelector('.calm-sub').textContent = parts.length ? `${parts.join(' and ')}.` : 'Every session is open but quiet.'
}

function renderEmpty(on) {
  const box = byId('empty-all')
  box.hidden = !on
  if (!on || box.childElementCount) return
  box.append(
    pets.free('empty', { hat: 'tophat', mood: 'sleep' }),
    h(
      'div',
      {},
      h('strong', { text: 'No agent sessions are running.' }),
      h('p', { text: 'Start Claude Code, Codex, Grok or Devin in any repo and it appears here. Ideas, assumptions and settings are in the panels.' }),
    ),
  )
}

function scopeName() {
  if (prefs.scope === 'all') return 'every folder'
  const project = state.projects.get(prefs.scope)
  if (project) return project.name
  const s = state.sessions.find((x) => scopeKeyOf(x) === prefs.scope)
  return s ? repoOf(s) : 'this folder'
}

// ================================================================================================
// Session list: rows grouped Working, Done, Open, Ended; each keeps its elements across updates
// ================================================================================================

const rowViews = new Map()
const detailViews = new Map()
const detailIds = new Map()
const resumeViews = new Set()
const groupEls = {
  working: { section: byId('working'), list: byId('working-rows'), n: byId('working-n') },
  done: { section: byId('done'), list: byId('done-rows'), n: byId('done-n') },
  open: { section: byId('open'), list: byId('open-rows'), n: byId('open-n') },
  ended: { section: byId('ended'), list: byId('ended-rows'), n: byId('ended-n') },
}

function detailId(key) {
  if (!detailIds.has(key)) detailIds.set(key, uid('detail'))
  return detailIds.get(key)
}

function groupOf(s) {
  if (s.state === 'working') return 'working'
  if (s.state === 'idle') return 'done'
  if (s.state === 'open') return 'open'
  if (s.state === 'ended') return 'ended'
  return null
}

// Files two live sessions both changed in one worktree: a marker on every row involved, and one
// note under the working one.
function clashIndex() {
  const marks = new Map()
  const notes = new Map()
  for (const g of Array.isArray(state.snap?.clashes) ? state.snap.clashes : []) {
    const edits = Array.isArray(g?.edits) ? g.edits.filter((e) => e && typeof e.key === 'string') : []
    if (edits.length < 2) continue
    for (const e of edits) marks.set(e.key, [...(marks.get(e.key) ?? []), g])
    const listed = (e) => {
      const s = state.byKey.get(e.key)
      return s && s.state !== 'waiting' && inScope(s)
    }
    const target = edits.find((e) => listed(e) && state.byKey.get(e.key).state === 'working') ?? edits.find(listed)
    if (target) notes.set(target.key, [...(notes.get(target.key) ?? []), { ...g, edits }])
  }
  return { marks, notes }
}

function renderList() {
  const { marks, notes } = clashIndex()
  const shown = state.sessions.filter((s) => s.state !== 'waiting' && inScope(s))
  const groups = { working: [], done: [], open: [], ended: [] }
  for (const s of shown) {
    const g = groupOf(s)
    if (g) groups[g].push(s)
  }
  // Working rows keep their place (newest started first); the rest are newest first.
  groups.working.sort((a, b) => (b.startedAt ?? b.since) - (a.startedAt ?? a.since) || a.key.localeCompare(b.key))
  for (const g of ['done', 'open', 'ended']) groups[g].sort((a, b) => b.since - a.since || a.key.localeCompare(b.key))
  const endedCount = groups.ended.length
  if (!prefs.showEnded) groups.ended = []

  const placed = new Set()
  for (const [name, list] of Object.entries(groups)) {
    const els = groupEls[name]
    let visible = list
    if (name === 'done' && !state.showAllDone && list.length > DONE_SHOWN) {
      visible = list.filter((s, i) => i < DONE_SHOWN || state.expanded.has(s.key))
    }
    els.section.hidden = list.length === 0
    els.n.textContent = String(list.length)
    visible.forEach((s, i) => {
      let view = rowViews.get(s.key)
      if (!view) {
        view = makeRow(s.key)
        rowViews.set(s.key, view)
      }
      updateRow(view, s, { marks, notes })
      placed.add(s.key)
      if (els.list.children[i] !== view.li) els.list.insertBefore(view.li, els.list.children[i] ?? null)
    })
    while (els.list.children.length > visible.length) els.list.lastElementChild.remove()
    if (name === 'done') {
      const hiddenCount = list.length - visible.length
      byId('done-more').hidden = list.length <= DONE_SHOWN
      byId('done-more-btn').textContent = state.showAllDone ? 'Show fewer done' : `Show ${hiddenCount} more done`
    }
  }
  for (const [key, view] of rowViews) {
    if (placed.has(key)) continue
    view.li.remove()
    view.fitSig = ''
    if (!state.byKey.has(key)) {
      for (const id of [view.tileId, ...view.clashTiles.values()]) if (id) pets.release(id)
      rowViews.delete(key)
      detailIds.delete(key)
    }
  }
  for (const [key, detail] of detailViews) {
    if (state.byKey.has(key)) continue
    detail.root.remove()
    detail.dispose()
    detailViews.delete(key)
  }

  // Details: in their row, or under the needs-you frame while the session waits.
  for (const [key, detail] of detailViews) {
    const s = state.byKey.get(key)
    const open = state.expanded.has(key)
    detail.root.hidden = !open
    if (!open || !s) continue
    if (s.state !== 'waiting') {
      const row = rowViews.get(key)
      if (row && placed.has(key) && detail.root.parentNode !== row.li) row.li.append(detail.root)
    }
    detail.update(s)
  }
  for (const key of state.expanded) {
    if (detailViews.has(key)) continue
    const s = state.byKey.get(key)
    if (!s) continue
    const detail = detailFor(key)
    if (s.state === 'waiting') needs.details.append(detail.root)
    else rowViews.get(key)?.li.append(detail.root)
    detail.root.hidden = false
    detail.update(s)
  }

  const line = byId('ended-line')
  line.hidden = !state.snap || (!endedCount && !prefs.showEnded)
  byId('ended-text').textContent = prefs.showEnded
    ? endedCount
      ? `Showing ${plural(endedCount, 'session')} that ended in the last 24 h.`
      : 'No session ended in the last 24 h.'
    : endedCount
      ? `${plural(endedCount, 'ended session is', 'ended sessions are')} hidden.`
      : 'Ended sessions are hidden.'
  const toggleEnded = byId('show-ended')
  toggleEnded.textContent = prefs.showEnded ? 'Hide ended' : 'Show ended'
  toggleEnded.setAttribute('aria-pressed', String(prefs.showEnded))
}

// The row button is named by every cell a sighted reader scans: title (with "same file" and what it
// means), agent, repo, status and time. The repo name is one span that moves into the repo button
// or the plain repo text, so the name never reads the button's own "open its ideas" label.
function makeRow(key) {
  const ids = { title: uid('rt'), agent: uid('ra'), repo: uid('rr'), now: uid('rn'), time: uid('rw') }
  const hit = h('button', {
    type: 'button',
    class: 'row-hit',
    'aria-expanded': 'false',
    'aria-controls': detailId(key),
    'aria-labelledby': `${ids.title} ${ids.agent} ${ids.repo} ${ids.now} ${ids.time}`,
  })
  const tileCell = h('span', { class: 'tile-cell' })
  const name = h('span', { class: 'r-name' })
  const say = h('span', { class: 'say', hidden: true })
  const markWhy = h('span', { class: 'vh' })
  const mark = h('span', { class: 'mark', hidden: true }, 'same file', markWhy)
  const title = h('span', { class: 'r-title', id: ids.title }, name, say, mark)
  const agent = h('span', { class: 'r-agent', id: ids.agent })
  const repoName = h('span', { id: ids.repo })
  const repo = h('button', { type: 'button', class: 'r-repo' })
  const repoText = h('span', { class: 'r-repo', hidden: true })
  const now = h('span', { class: 'r-now', id: ids.now })
  const time = h('span', { class: 'r-time', id: ids.time })
  const line = h('div', { class: 'row-line' }, hit, tileCell, title, h('span', { class: 'r-sub' }, agent, repo, repoText, now), time)
  const clash = h('div', { class: 'clash', hidden: true })
  const li = h('li', { class: 'row' }, line, clash)
  hit.addEventListener('click', () => toggle(key))
  repo.addEventListener('click', () => {
    if (repo.dataset.project) openRepo(repo.dataset.project, repo)
  })
  return {
    key,
    li,
    hit,
    tileCell,
    title,
    name,
    say,
    mark,
    markWhy,
    agent,
    repo,
    repoName,
    repoText,
    now,
    time,
    clash,
    kind: null,
    tileId: null,
    nowSig: '',
    fitSig: '',
    clashSig: '',
    clashTiles: new Map(), // edit key -> tile id
    clashAges: new Map(), // edit key -> its "40s ago" text
  }
}

const ROW_KIND = { working: 'work', idle: 'done', open: 'open', ended: 'ended' }

function updateRow(view, s, { marks, notes }) {
  const kind = ROW_KIND[s.state] ?? 'done'
  const tileId = kind === 'open' ? `open:${s.key}` : kind === 'ended' ? `ended:${s.key}` : `row:${s.key}:${kind}`
  if (tileId !== view.tileId) {
    if (view.tileId) pets.release(view.tileId)
    view.tileId = tileId
    const tile =
      kind === 'open'
        ? h('span', { class: 'tile tile-open', role: 'img', 'aria-label': 'No Clawd: this session sends no events', text: '◇' })
        : kind === 'ended'
          ? pets.still(tileId, { hat: s.hat ?? 'tophat', mood: 'idle', grey: true, label: `Clawd in ${hatWords(s.hat ?? 'tophat')}, gone home` })
          : pets.tile(tileId, s.key, kind)
    view.tileCell.replaceChildren(tile)
  }
  view.kind = kind
  const stale = kind === 'done' && serverNow() - s.since > STALE_MS
  const fresh = state.fresh.get(s.key)
  view.li.className = ['row', `is-${kind}`, stale ? 'is-stale' : '', fresh && Date.now() - fresh < 2600 ? 'is-fresh' : ''].filter(Boolean).join(' ')

  setText(view.name, titleOf(s))
  const bubble = rowBubble(pets.bubbleOf(s.key))
  sayInRow(view, bubble)
  view.mark.hidden = !marks.has(s.key)
  setText(view.markWhy, view.mark.hidden ? '' : `: another session changed ${marks.get(s.key).map((g) => baseName(g.file)).join(', ')} in this worktree within 30 min`)
  setText(view.agent, s.agentLabel ?? s.agent ?? '')
  const project = projectOf(s)
  view.repo.hidden = !project
  view.repoText.hidden = Boolean(project)
  const repoHolder = project ? view.repo : view.repoText
  if (view.repoName.parentNode !== repoHolder) repoHolder.replaceChildren(view.repoName)
  setText(view.repoName, project ? project.name : s.project ?? '')
  if (project) {
    view.repo.dataset.project = project.id
    view.repo.setAttribute('aria-label', `${project.name}: open its ${repoPanel(project)}`)
  }

  renderNow(view, s, kind)
  liveText(view.time, s.since, (at) => `${timeWord(s)} ${ago(at)}`)
  const expanded = state.expanded.has(s.key)
  view.hit.setAttribute('aria-expanded', String(expanded))
  renderClash(view, notes.get(s.key) ?? [])
  // Measured again only when something that decides what fits changed, or the row was out of the list.
  const fitSig = JSON.stringify([kind, view.name.textContent, view.say.hidden ? '' : bubble, view.mark.hidden, view.nowSig])
  if (fitSig !== view.fitSig) {
    view.fitSig = fitSig
    queueFit(view)
  }
}

function renderNow(view, s, kind) {
  const newest = baseName(s.files?.[0])
  const tasks = s.tasks && Number.isFinite(s.tasks.total) && s.tasks.total > 0 ? s.tasks : null
  const sig = JSON.stringify([kind, s.doing, s.next, newest, tasks, (s.taskList ?? []).map((t) => t.status), s.done, firstLine(s.answer), kind === 'ended' ? firstLine(s.prompt) : ''])
  if (sig === view.nowSig) return
  view.nowSig = sig
  const g = (glyph) => h('span', { class: 'g', 'aria-hidden': 'true', text: glyph })
  const parts = []
  if (kind === 'work') {
    parts.push(g('●'))
    if (s.doing) {
      parts.push(h('span', { class: 'txt', text: s.doing }))
      if (s.next) parts.push(h('span', { class: 'nx', text: `· next: ${s.next}` }))
    } else if (newest) parts.push(h('span', { class: 'txt' }, 'Edited ', h('code', { text: newest })))
    else parts.push(h('span', { class: 'txt', text: 'Working' }))
    if (tasks) {
      parts.push(h('span', { class: 'pips', 'aria-hidden': 'true' }, pips(s, tasks).map((st) => h('i', { class: `pip pip-${st}` }))))
      parts.push(h('span', { class: 'meta' }, h('span', { 'aria-hidden': 'true', text: `${tasks.done}/${tasks.total}` }), h('span', { class: 'vh', text: `, ${tasks.done} of ${tasks.total} tasks done` })))
    }
    if (s.doing && newest) parts.push(h('code', { class: 'file', text: newest }))
  } else if (kind === 'done') {
    parts.push(g('✓'), h('span', { class: 'txt', text: outcome(s) }))
  } else if (kind === 'open') {
    parts.push(g('◇'), h('span', { class: 'txt', text: 'No status' }))
  } else {
    // An ended session with no outcome is named by what it was asked to do.
    parts.push(g('○'), h('span', { class: 'txt', text: outcome(s, firstLine(s.prompt) || 'Ended') }))
  }
  view.now.replaceChildren(...parts)
}

// One pip per task (at most ten): done, doing, to do; from the task list when there is one.
function pips(s, tasks) {
  const list = Array.isArray(s.taskList) && s.taskList.length ? s.taskList : null
  const marks = list
    ? list.map((t) => (t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'now' : 'todo'))
    : [...Array(Math.min(tasks.done, 10)).fill('done'), ...Array(Math.max(0, Math.min(tasks.total, 10) - tasks.done)).fill('todo')]
  return marks.slice(0, 10)
}

// What fits in a row short of room, decided for every row that changed in one pass a frame: every
// class off, then every measurement, then the classes back on, so the page lays out once (twice when
// a status cell had to give something up) however many rows or bubbles changed.
// - The pet's bubble shows whole or not at all, and never costs the title its words.
// - A working row's status keeps the doing text whole first (see .r-now in app.css): "next: ..."
//   shows only when everything else is whole, the file name shrinks to a few letters, and when the
//   cell still overflows the file name goes and only then the doing text may shrink.
const cutOff = (el) => el.scrollWidth > el.clientWidth + 1
const fits = { titles: new Set(), nows: new Set(), frame: 0 }

function queueFit(view, { title = true, now = true } = {}) {
  if (title) fits.titles.add(view)
  if (now) fits.nows.add(view)
  if (!fits.frame) fits.frame = window.requestAnimationFrame(runFits)
}

function fitAll() {
  for (const view of rowViews.values()) queueFit(view)
}

function runFits() {
  fits.frame = 0
  const titles = [...fits.titles].filter((view) => view.li.isConnected)
  const nows = [...fits.nows].filter((view) => view.li.isConnected && view.kind === 'work')
  fits.titles.clear()
  fits.nows.clear()
  for (const view of titles) view.title.classList.remove('no-room')
  for (const view of nows) view.now.classList.remove('fits-less', 'fits-least')
  const noRoom = titles.filter((view) => !view.say.hidden && (cutOff(view.name) || cutOff(view.say)))
  const less = nows.filter((view) => cutOff(view.now) || [...view.now.querySelectorAll('.txt, .file')].some(cutOff))
  for (const view of noRoom) view.title.classList.add('no-room')
  for (const view of less) view.now.classList.add('fits-less')
  const least = less.filter((view) => cutOff(view.now))
  for (const view of least) view.now.classList.add('fits-least')
}

// The note under a row whose file another session also changed. Its pets are kept by edit key and
// its text is rebuilt only when who or what changes: a session that keeps editing the file only
// moves its "40s ago", which ticks on its own.
const clashAge = (at) => `${ago(at)}\u00a0ago`

function renderClash(view, groups) {
  const g = groups[0]
  const shown = g ? g.edits.slice(0, 3) : []
  for (const e of g?.edits ?? []) {
    const age = view.clashAges.get(e.key)
    if (age) liveText(age, e.at, clashAge)
  }
  const sig = JSON.stringify([state.byKey.get(view.key)?.state, groups.length, g ? [g.file, g.edits.map((e) => [e.key, e.name])] : null])
  if (sig === view.clashSig) return
  view.clashSig = sig
  const keep = new Set(shown.map((e) => e.key))
  for (const [editKey, id] of view.clashTiles) {
    if (keep.has(editKey)) continue
    pets.release(id)
    view.clashTiles.delete(editKey)
  }
  view.clashAges.clear()
  view.clash.hidden = !g
  if (!g) {
    view.clash.replaceChildren()
    return
  }
  const tiles = shown.map((e) => {
    if (!view.clashTiles.has(e.key)) view.clashTiles.set(e.key, `clash:${view.key}:${e.key}`)
    return pets.tile(view.clashTiles.get(e.key), e.key, 'xs')
  })
  const text = h('span', { class: 'clash-text' }, h('strong', { text: `${countWord(g.edits.length)} sessions changed ` }), h('code', { text: baseName(g.file), title: g.file }), h('strong', { text: ' in the same worktree within 30 min: ' }))
  g.edits.forEach((e, i) => {
    // A no-break space ties each name to its time and "57s" to "ago", so neither splits at a wrap.
    const age = liveText(h('span'), e.at, clashAge)
    view.clashAges.set(e.key, age)
    text.append(i ? ', ' : '', `${e.name || titleOf(state.byKey.get(e.key) ?? {})}\u00a0`, age)
  })
  text.append('.')
  if (groups.length > 1) text.append(` And ${plural(groups.length - 1, 'more file')}.`)
  const target = state.byKey.get(view.key)
  const label = target?.state === 'working' ? 'Message the working one' : `Message ${titleOf(target ?? {})}`
  const button = h('button', { type: 'button', class: 'btn btn-s' }, icon('send'), h('span', { class: 'lbl', text: label }))
  button.addEventListener('click', () => openMessage(view.key))
  view.clash.replaceChildren(h('span', { class: 'clash-pets', 'aria-hidden': 'true' }, tiles), text, button)
}

function toggle(key, open = !state.expanded.has(key)) {
  if (open) {
    state.expanded.add(key)
    state.lastExpanded = key
  } else state.expanded.delete(key)
  render()
}

// Expands a session and puts the cursor in its message box. A full-screen panel closes first: the
// box is in the list behind it.
function openMessage(key) {
  const s = state.byKey.get(key)
  if (!s) return
  if (isSheetOpen()) closePanel({ refocus: false })
  if (!inScope(s)) setScope('all', false)
  toggle(key, true)
  const detail = detailViews.get(key)
  if (!detail) return
  detail.root.scrollIntoView({ block: 'center', behavior: reducedMotion?.matches ? 'auto' : 'smooth' })
  const input = detail.messageInput()
  if (input) input.focus({ preventScroll: true })
}

// ================================================================================================
// Session detail: what it is doing, its tasks and files, its resume command and its message box
// ================================================================================================

function detailFor(key) {
  let view = detailViews.get(key)
  if (!view) {
    view = makeDetail(key)
    detailViews.set(key, view)
  }
  return view
}

const CLAWD_BUTTONS = [
  ['pet', 'Pet'],
  ['dance', 'Dance'],
  ['party', 'Party'],
]

function makeDetail(key) {
  const stripSay = h('p', { class: 'strip-say' })
  const stripStatus = h('p', { class: 'strip-status', role: 'status' })
  const clawdButtons = CLAWD_BUTTONS.map(([verb, text]) => {
    const button = h('button', { type: 'button', class: 'btn btn-console', text })
    button.addEventListener('click', () => clawd(verb, key, stripStatus, button))
    return button
  })
  const stripActs = h('div', { class: 'strip-acts', role: 'group', 'aria-label': "Play with this session's Clawd" }, clawdButtons)
  const strip = h('div', { class: 'strip', hidden: true })
  let stripTile = null
  const talk = h('section', { class: 'd-talk' })
  const tasks = h('section', { class: 'd-tasks', hidden: true })
  const files = h('section', { class: 'd-files' })
  const grid = h('div', { class: 'd-grid' }, talk, tasks, files)
  const resume = makeResume(key)
  const message = makeMessage(key)
  const brief = makeBrief(key, (text) => message.fill(text))
  const actRow = h('div', { class: 'd-act' }, resume.root, message.root)
  const root = h('div', { class: 'detail', id: detailId(key) }, strip, brief.root, grid, actRow)
  const sigs = { talk: '', tasks: '', files: '' }

  function update(s) {
    const working = s.state === 'working'
    strip.hidden = !working
    if (working && !stripTile) {
      stripTile = `strip:${key}`
      strip.replaceChildren(pets.tile(stripTile, key, 'strip'), stripSay, stripActs, stripStatus)
      stripSay.textContent = pets.bubbleOf(key)
    }
    stripActs.hidden = Boolean(s.native)

    const talkSig = JSON.stringify([s.state, s.doing, s.next, s.done, s.waitingFor, s.prompt, s.answer, s.native])
    if (talkSig !== sigs.talk) {
      sigs.talk = talkSig
      talk.replaceChildren(...talkParts(s))
    }
    const list = Array.isArray(s.taskList) ? s.taskList : []
    const taskSig = JSON.stringify([list, s.tasks])
    if (taskSig !== sigs.tasks) {
      sigs.tasks = taskSig
      tasks.hidden = !list.length && !s.tasks
      tasks.replaceChildren(...(tasks.hidden ? [] : taskParts(s, list)))
    }
    grid.className = tasks.hidden ? 'd-grid d-grid-2' : 'd-grid'
    const fileSig = JSON.stringify([s.files, s.lastEditAt, s.cwd, s.worktree, s.home, s.startedAt, s.turns, s.id, s.project, s.projectId, s.agent])
    if (fileSig !== sigs.files) {
      sigs.files = fileSig
      files.replaceChildren(...fileParts(s))
    }
    resume.update(s)
    message.update(s)
    brief.update(s, root.hidden)
    actRow.className = s.state === 'ended' ? 'd-act d-act-1' : 'd-act'
  }

  function dispose() {
    if (stripTile) pets.release(stripTile)
    resumeViews.delete(resume)
  }

  return { root, stripSay, update, dispose, messageInput: () => message.input() }
}

// First prompt, context used and the suggested next prompt. Fetched when the detail is open.
// A closed row does not read a transcript on every snapshot.
const BRIEF_WAIT_MS = 15_000

function makeBrief(key, fill) {
  const context = h('p', { class: 'd-context', text: 'Reading this session…' })
  const bar = h('span')
  const meter = h('div', { class: 'd-meter', hidden: true, title: 'Share of the context window in use' }, bar)
  const prompt = h('pre', { class: 'd-prompt' })
  const promptNote = h('p', { class: 'd-prompt-note', hidden: true })
  const promptWrap = h('div', { hidden: true }, h('h3', { class: 'd-h', text: 'First prompt' }), prompt, promptNote)
  const suggestion = h('pre', { class: 'd-prompt d-suggest' })
  const suggestWrap = h('div', { hidden: true }, h('h3', { class: 'd-h', text: 'Suggested next prompt' }), suggestion)
  const root = h('section', { class: 'd-brief', 'aria-label': 'First prompt, context used and a suggested next prompt' }, context, meter, promptWrap, suggestWrap)
  let ticket = 0
  let shown = ''
  let at = 0

  async function update(s, hidden) {
    if (hidden) return
    const sig = `${s.turns ?? ''}:${s.state ?? ''}`
    if (shown && Date.now() - at < BRIEF_WAIT_MS) return
    shown = sig
    at = Date.now()
    const mine = ++ticket
    const r = await call(`/api/brief?key=${encodeURIComponent(key)}`)
    if (mine !== ticket) return
    at = Date.now()
    if (!r.ok) {
      context.textContent = r.text || 'Could not read this session.'
      meter.hidden = true
      return
    }
    const data = r.body ?? {}
    context.textContent = typeof data.contextText === 'string' ? data.contextText : 'Context used: not recorded for this session.'
    const percent = Number(data.context?.percent)
    meter.hidden = !Number.isFinite(percent)
    if (Number.isFinite(percent)) bar.style.width = `${Math.max(0, Math.min(100, percent))}%`
    const text = typeof data.firstPrompt === 'string' ? data.firstPrompt : ''
    promptWrap.hidden = !text
    prompt.textContent = text
    promptNote.hidden = data.truncated !== true
    promptNote.textContent = data.truncated === true ? 'Showing the first 100,000 characters.' : ''
    const next = typeof data.suggestion === 'string' ? data.suggestion : ''
    suggestWrap.hidden = !next
    suggestion.textContent = next
    if (next) fill(next)
  }

  return { root, update }
}

function talkParts(s) {
  const out = []
  const pairs = []
  if (s.state === 'waiting') pairs.push(['Waiting', reasonOf(s)])
  if (s.state === 'working' && s.doing) pairs.push(['Doing', s.doing])
  if (s.state === 'working' && s.next) pairs.push(['Next', s.next])
  if (s.done) pairs.push(['Done', s.done])
  if (pairs.length) out.push(h('dl', { class: 'd-dn' }, pairs.map(([dt, dd]) => h('div', {}, h('dt', { text: dt }), h('dd', { text: dd })))))
  if (s.prompt) out.push(h('h3', { class: 'd-h', text: 'Last prompt' }), h('blockquote', { class: 'd-quote', text: s.prompt }))
  if (s.answer) out.push(h('h3', { class: 'd-h', text: 'Last answer' }), h('p', { class: 'd-quote', text: s.answer }))
  if (!out.length) {
    out.push(
      h('p', {
        class: 'd-empty',
        text: s.native
          ? s.state === 'open'
            ? "No status, prompt or files: Grok's registry only records that this session is open."
            : 'No prompt or files: this session is known only from its agent\'s own registry, not from agent-mods hooks.'
          : "No prompt or answer was recorded for this session's last turn.",
      }),
    )
  }
  return out
}

function taskParts(s, list) {
  if (!list.length) {
    const t = s.tasks
    return [h('h3', { class: 'd-h', text: 'Tasks' }), h('p', { class: 'd-empty', text: `${t.done} of ${t.total} done.` })]
  }
  const done = list.filter((t) => t.status === 'completed').length
  const nextAt = list.findIndex((t) => t.status === 'pending')
  return [
    h('h3', { class: 'd-h' }, 'Tasks', h('span', { class: 'd-h-n', text: `${done} of ${s.tasks?.total ?? list.length} done` })),
    h(
      'ol',
      { class: 'tasks' },
      list.map((t, i) => {
        const cls = t.status === 'completed' ? 't-done' : t.status === 'in_progress' ? 't-now' : i === nextAt ? 't-next' : 't-todo'
        const glyph = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◆' : i === nextAt ? '→' : '○'
        const note = t.status === 'in_progress' ? 'doing' : i === nextAt ? 'next' : ''
        return h('li', { class: cls }, h('span', { class: 't-ic', 'aria-hidden': 'true', text: glyph }), h('span', {}, t.text, note ? h('em', { text: note }) : null, h('span', { class: 'vh', text: t.status === 'completed' ? ' (done)' : '' })))
      }),
    ),
  ]
}

function fileParts(s) {
  const out = []
  const list = Array.isArray(s.files) ? s.files : []
  if (list.length) {
    out.push(
      h('h3', { class: 'd-h', text: 'Files' }),
      h(
        'ul',
        { class: 'files' },
        list.map((file, i) =>
          h('li', {}, pathCode(file), i === 0 && Number.isFinite(s.lastEditAt) ? liveText(h('span'), s.lastEditAt, (at) => ago(at)) : null),
        ),
      ),
    )
  }
  const facts = []
  const project = projectOf(s)
  if (project) facts.push(['Repo', project.name])
  if (s.worktree && project?.path && s.worktree.toLowerCase().replace(/\\/g, '/') !== String(project.path).toLowerCase().replace(/\\/g, '/')) facts.push(['Worktree', pathCode(baseName(s.worktree))])
  if (s.cwd) facts.push(['Folder', pathCode(s.cwd)])
  facts.push(['Home', homeLabel(s)])
  if (Number.isFinite(s.startedAt)) facts.push(['Started', liveText(h('span'), s.startedAt, agoWords)])
  if (Number.isFinite(s.turns)) facts.push(['Turns', String(s.turns)])
  facts.push(['Session', h('code', { text: String(s.id ?? '') })])
  out.push(h('dl', { class: 'd-facts' }, facts.map(([dt, dd]) => h('div', {}, h('dt', { text: dt }), h('dd', {}, dd)))))
  return out
}

// --- resume command -----------------------------------------------------------------------------

const resumeCache = new Map()

const resumeSig = (s, shell) => JSON.stringify([s.key, shell, s.id, s.cwd, s.home])

function resumeProblem(r, s, shell) {
  if (r.status === 404) return 'This session is no longer on the dashboard, so it has no resume command here.'
  if (r.status === 409 && s.canResume !== false) {
    const others = SHELLS.filter(([v]) => v !== shell).map(([, name]) => name)
    return `No safe ${SHELL_NAMES[shell]} command for this session (its folder or id has characters ${SHELL_NAMES[shell]} would run). Pick ${others.join(' or ')} instead.`
  }
  return r.text
}

async function resumeFor(s, shell = prefs.shell) {
  const sig = resumeSig(s, shell)
  if (resumeCache.has(sig)) return resumeCache.get(sig)
  const r = await call(`/api/resume?key=${encodeURIComponent(s.key)}&shell=${encodeURIComponent(shell)}`)
  const value = r.ok && typeof r.body?.command === 'string' ? { command: r.body.command, note: typeof r.body.note === 'string' ? r.body.note : '' } : { problem: resumeProblem(r, s, shell), status: r.status }
  if (r.ok) resumeCache.set(sig, value)
  return value
}

// The button says what happened in a word or two; the status line beside it says why, or which
// shell the copied command is for (and Devin's note).
async function copyResume(s, button, status) {
  const r = await resumeFor(s)
  if (r.problem) {
    // 404 and 409 mean there is no command to give; anything else (no key, no process, an error)
    // means the page could not get one, and the status line says why.
    flash(button, r.status === 404 || r.status === 409 ? 'No command to copy' : "Couldn't get the command")
    if (status) status.textContent = r.problem
    return
  }
  const ok = await copyText(r.command)
  flash(button, ok ? 'Copied' : 'Copy blocked: open details and select it')
  if (status) {
    const shell = `${SHELL_NAMES[prefs.shell]} command: paste it in a terminal.`
    status.textContent = ok ? (r.note ? `${shell} ${r.note}` : shell) : 'The browser blocked the clipboard. Show details and select the command.'
  }
  announce(ok ? 'Resume command copied.' : 'The browser blocked the copy.')
}

function makeResume(key) {
  const group = uid('shell')
  const inputs = SHELLS.map(([value, text]) => {
    const id = uid('sh')
    const input = h('input', { type: 'radio', name: group, value, id })
    input.addEventListener('change', () => {
      if (input.checked) setShell(value)
    })
    return [input, h('label', { for: id, text })]
  })
  const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Shell for the resume command' }, inputs)
  const code = h('code')
  const pre = h('pre', { class: 'cmd' }, code)
  const note = h('p', { class: 'cmd-note', hidden: true })
  const problem = h('p', { class: 'cmd-err', role: 'status', hidden: true })
  const copy = h('button', { type: 'button', class: 'btn' }, icon('copy'), h('span', { class: 'lbl', text: 'Copy resume command' }))
  const root = h('section', { class: 'd-resume', 'aria-label': 'Resume command' }, h('div', { class: 'd-resume-head' }, h('h3', { class: 'd-h', text: 'Resume command' }), seg), pre, note, problem, copy)
  let shown = ''
  let session = null
  let command = ''

  copy.addEventListener('click', async () => {
    if (!command) {
      flash(copy, 'No command to copy')
      return
    }
    const ok = await copyText(command)
    flash(copy, ok ? 'Copied. Paste it in a terminal' : 'Copy blocked: select the command above')
    announce(ok ? 'Resume command copied.' : 'The browser blocked the copy.')
  })

  async function load() {
    const s = session
    if (!s) return
    for (const [input] of inputs) input.checked = input.value === prefs.shell
    const sig = resumeSig(s, prefs.shell)
    if (sig === shown) return
    shown = sig
    command = ''
    if (s.canResume === false) {
      pre.hidden = true
      copy.hidden = true
      problem.hidden = false
      problem.textContent = `${s.agentLabel} sessions cannot be reopened from a terminal.`
      return
    }
    pre.classList.add('is-loading')
    code.textContent = 'Asking the dashboard for the command…'
    const r = await resumeFor(s)
    if (shown !== sig) return
    pre.classList.remove('is-loading')
    pre.hidden = Boolean(r.problem)
    copy.hidden = Boolean(r.problem)
    problem.hidden = !r.problem
    problem.textContent = r.problem ?? ''
    note.hidden = !r.note
    note.textContent = r.note ?? ''
    if (!r.problem) {
      command = r.command
      code.textContent = r.command
    }
  }

  const view = {
    root,
    update(s) {
      session = s
      load()
    },
    refresh: () => load(),
  }
  resumeViews.add(view)
  return view
}

function setShell(shell) {
  if (!SHELL_NAMES[shell]) return
  prefs.shell = shell
  store.set('shell', shell)
  for (const view of resumeViews) view.refresh()
}

// --- message box --------------------------------------------------------------------------------

function makeMessage(key) {
  const inputId = uid('msg')
  const hintId = uid('msgh')
  const input = h('textarea', { id: inputId, class: 'msg-box', rows: '4', maxLength: 2000, placeholder: 'Prompt to continue this session', 'aria-describedby': hintId })
  const count = h('span', { class: 'msg-count', 'aria-hidden': 'true', text: '0/2000' })
  const delivery = h('span')
  const send = h('button', { type: 'submit', class: 'btn' }, h('span', { class: 'lbl', text: 'Queue message' }))
  const compact = h('button', { type: 'button', class: 'btn' }, h('span', { class: 'lbl', text: 'Auto compact, then send' }))
  const unread = h('p', { class: 'msg-unread' })
  const warn = h('p', { class: 'd-note d-note-strong', hidden: true })
  const result = h('p', { class: 'msg-result', role: 'status' })
  const form = h(
    'form',
    { class: 'd-msg', novalidate: true },
    h('label', { class: 'd-h', for: inputId, text: 'Next prompt' }),
    input,
    h('div', { class: 'msg-actions' }, send, compact),
    h('p', { class: 'd-note', text: 'Auto compact, then send tells the session to compact and then do the text in the box. Queue message sends that text alone, up to 500 characters.' }),
    h('p', { class: 'msg-meta', id: hintId }, delivery, count),
    unread,
    warn,
    result,
  )
  const noInbox = h(
    'section',
    { class: 'd-msg', hidden: true },
    h('h3', { class: 'd-h', text: 'Messages' }),
    h('p', { class: 'd-note', text: 'This session has no agent-mods inbox: it is known only from its agent\'s own registry, so it cannot get messages. Answer it in its terminal, or reopen it with the resume command.' }),
  )
  const root = h('div', { class: 'd-msg-wrap' }, form, noInbox)
  let session = null
  let suggestion = ''

  function paintCount() {
    const n = input.value.trim().length
    count.textContent = `${n}/2000`
    count.classList.toggle('is-over', n > 2000)
  }

  input.addEventListener('input', paintCount)
  compact.addEventListener('click', async () => {
    const text = input.value.trim()
    if (!text) {
      result.textContent = 'Write the prompt in the box first.'
      input.focus()
      return
    }
    compact.disabled = true
    result.textContent = 'Queuing compact, then the prompt…'
    const r = await act('continue', { key, text })
    compact.disabled = false
    result.textContent = r.text || (r.ok ? 'Queued.' : 'Not sent.')
    if (r.ok) announce('Compact, then the prompt, queued.')
  })
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) {
      result.textContent = 'Write the prompt in the box first.'
      input.focus()
      return
    }
    if (text.length > 500) {
      result.textContent = 'Queue message takes at most 500 characters. Use Auto compact, then send for a longer prompt.'
      return
    }
    send.disabled = true
    result.textContent = 'Queueing…'
    const r = await act('send', { key, text })
    send.disabled = false
    result.textContent = r.text || (r.ok ? 'Queued.' : 'Not sent.')
    if (r.ok) {
      input.value = ''
      suggestion = ''
      paintCount()
      announce('Message queued.')
    }
  })

  return {
    root,
    fill(text) {
      if (input.value.trim() && input.value !== suggestion) return
      suggestion = text
      input.value = text
      paintCount()
    },
    input: () => (form.hidden ? null : input),
    update(s) {
      session = s
      root.hidden = s.state === 'ended'
      form.hidden = Boolean(s.native)
      noInbox.hidden = !s.native
      delivery.textContent = `${deliveryText(s)} Unread messages expire after 24 h.`
      unread.textContent = s.unread > 0 ? `${plural(s.unread, 'unread message')} waiting for this session.` : 'No unread messages for this session.'
      warn.hidden = s.state !== 'waiting'
      warn.textContent = /^approve\s/i.test(String(s.waitingFor ?? '').trim())
        ? "A message can't answer the permission prompt. Approve or deny it in its terminal."
        : "A message can't answer what it is waiting for. Answer it in its terminal."
      if (session.state === 'ended') result.textContent = ''
    },
  }
}

// --- Clawd, from the page -----------------------------------------------------------------------

async function clawd(verb, key, status, button, arg) {
  if (button) button.disabled = true
  const r = await act('clawd', { verb, ...(arg ? { arg } : {}), ...(key ? { key } : {}) })
  if (button) button.disabled = false
  if (status) {
    status.textContent = r.text
    status.classList.toggle('is-bad', !r.ok)
  }
  if (r.ok) {
    const data = r.body?.data ?? {}
    pets.play(key ?? null, { verb, arg: arg ?? '', ok: true, hat: data.hat, shades: data.prefs?.shades })
  }
  return r
}

// ================================================================================================
// Rail and panels
// ================================================================================================

const layout = byId('layout')
const railIndex = byId('rail-index')
let openPanelName = ''
let panelOpener = null
const panelState = { aRepo: 'all', aLimit: 20, iRepo: 'all' }

function repoPanel(project) {
  if (project.openAssumptions > 0) return 'assumptions'
  if (project.ideas?.length) return 'ideas'
  return 'assumptions'
}

function openRepo(projectId, from) {
  const project = state.projects.get(projectId)
  if (!project) return
  openPanel(repoPanel(project), { repo: projectId, from })
}

function panelEl(name) {
  return document.querySelector(`.panel[data-panel="${name}"]`)
}

// What a panel last drew from: an update that leaves it unchanged leaves the panel alone.
const panelSigs = new Map()
function unchanged(name, value) {
  const sig = JSON.stringify(value)
  if (panelSigs.get(name) === sig) return true
  panelSigs.set(name, sig)
  return false
}

// Below 1100 px (app.css) the rail sits under the list and an open panel is a full-screen sheet.
// While a sheet is open, everything behind it is inert: no focus, no reading, no clicks.
const sheetQuery = window.matchMedia ? window.matchMedia('(max-width: 1100px)') : null
const isSheetLayout = () => Boolean(sheetQuery?.matches)
const isSheetOpen = () => Boolean(openPanelName) && isSheetLayout()

function applySheet() {
  const on = isSheetOpen()
  for (const el of [document.querySelector('.skip'), byId('top'), byId('sessions')]) if (el) el.inert = on
}

function openPanel(name, { repo = null, from = null, focus = true } = {}) {
  if (!PANELS.includes(name)) return
  panelSigs.delete(name)
  if (name === 'assumptions') {
    panelState.aRepo = repo ?? 'all'
    panelState.aLimit = 20
    assumptionViews.clear()
  }
  if (name === 'ideas') panelState.iRepo = repo ?? 'all'
  openPanelName = name
  panelOpener = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
  for (const panel of document.querySelectorAll('.panel')) panel.hidden = panel.dataset.panel !== name
  railIndex.hidden = true
  layout.classList.add('has-panel')
  applySheet()
  store.set('panel', name)
  renderPanel()
  if (focus) panelEl(name)?.querySelector('h2')?.focus()
}

function closePanel({ refocus = true } = {}) {
  if (!openPanelName) return
  for (const panel of document.querySelectorAll('.panel')) panel.hidden = true
  openPanelName = ''
  railIndex.hidden = false
  layout.classList.remove('has-panel')
  applySheet()
  store.set('panel', '')
  assumptionViews.clear()
  if (refocus && panelOpener?.isConnected) panelOpener.focus()
  panelOpener = null
}

function renderPanel() {
  if (!state.snap) return
  const render = { assumptions: renderAssumptions, ideas: renderIdeas, rules: renderRules, decisions: renderDecisions, messages: renderMessages, activity: renderActivity, health: renderHealth, settings: renderSettings }[openPanelName]
  if (render) render()
}

const projectList = () => [...state.projects.values()]

function emptyBox(id, hat, lines, extra) {
  return h('div', { class: 'empty' }, pets.still(`empty:${id}`, { hat, mood: 'sleep' }), h('div', {}, lines.map((line, i) => (i === 0 && Array.isArray(line) ? h('p', {}, h('strong', { text: line[0] }), ' ', line[1]) : h('p', { text: line }))), extra ?? null))
}

function setCount(id, n, word) {
  const el = byId(id)
  if (el) el.textContent = `${n} ${word}`
}

// --- rail ---------------------------------------------------------------------------------------

function renderRail() {
  const projects = projectList()
  const sum = (fn) => projects.reduce((n, p) => n + fn(p), 0)
  const openA = sum((p) => p.openAssumptions ?? 0)
  const aRepos = projects.filter((p) => p.openAssumptions > 0).length
  rail('assumptions', openA, openA ? `Open in ${plural(aRepos, 'repo')}, waiting for right or wrong` : 'Nothing waiting for a verdict')
  const ideas = sum((p) => ideaCounts(p).open)
  const taken = sum((p) => ideaCounts(p).taken)
  const iRepos = projects.filter((p) => ideaCounts(p).total > 0).length
  rail('ideas', ideas, ideas || taken ? `Shelved in ${plural(iRepos, 'repo')}${taken ? `, ${taken} taken` : ''}` : 'The shelf is empty')
  const rules = sum((p) => p.rules?.length ?? 0)
  rail('rules', rules, rules ? `In ${plural(projects.filter((p) => p.rules?.length).length, 'repo')}` : 'A wrong assumption plus your correction makes one')
  const decisions = sum((p) => p.decisions?.length ?? 0)
  rail('decisions', decisions, decisions ? `In ${plural(projects.filter((p) => p.decisions?.length).length, 'repo')}` : 'None remembered yet')
  const unread = state.sessions.reduce((n, s) => n + (s.state !== 'ended' && s.unread > 0 ? s.unread : 0), 0)
  const inboxes = state.sessions.filter((s) => s.state !== 'ended' && s.unread > 0).length
  rail('messages', unread, unread ? `Unread in ${plural(inboxes, 'session')}; they expire after 24 h` : 'None queued')
  renderRailActivity()
  const health = healthIssues()
  const errors = state.snap?.health?.errors?.count ?? 0
  byId('ri-health-n').textContent = errors ? plural(errors, 'error') : health.silent.length ? 'check' : 'no errors'
  const quiet = health.silent[0]
  if (quiet) liveText(byId('ri-health-s'), quiet.session.since, (at) => `${quiet.who}: working, no hook for ${silentMinutes(at)}`)
  else {
    liveTexts.delete(byId('ri-health-s'))
    byId('ri-health-s').textContent = health.summary
  }
  railItem('health').classList.toggle('is-warn', Boolean(errors || health.silent.length))
  const settings = state.snap?.settings ?? {}
  const level = settings.plain?.level ?? 'off'
  byId('ri-settings-s').textContent = `Plain talk ${level === 'off' ? 'off' : level}. Finish alerts ${settings.notify?.enabled ? `on, after ${Math.round((settings.notify.afterMs ?? 30000) / 1000)} s` : 'off'}`
}

function railItem(name) {
  return document.querySelector(`.ri[data-panel="${name}"]`)
}

function rail(name, n, sub) {
  byId(`ri-${name}-n`).textContent = String(n)
  byId(`ri-${name}-s`).textContent = sub
  railItem(name).classList.toggle('is-zero', n === 0)
}

function renderRailActivity() {
  const last = state.activity[state.activity.length - 1]
  const n = byId('ri-activity-n')
  if (!last) {
    n.textContent = ''
    byId('ri-activity-s').textContent = 'Nothing in the last 30 minutes'
    return
  }
  liveText(n, last.t, (at) => ago(at))
  byId('ri-activity-s').textContent = `${who(last)} ${whatOf(last)}${last.project ? ` in ${last.project}` : ''}`
}

// --- assumptions --------------------------------------------------------------------------------

const assumptionViews = new Map()

function renderAssumptions() {
  const projects = projectList()
  const total = projects.reduce((n, p) => n + (p.openAssumptions ?? 0), 0)
  setCount('p-assumptions-count', total, 'open')
  const body = byId('p-assumptions-body')
  if (panelState.aRepo !== 'all' && !state.projects.has(panelState.aRepo)) panelState.aRepo = 'all'
  const resolvedKeys = [...assumptionViews.values()].filter((v) => v.resolved).map((v) => v.key)
  const data = projects.map((p) => [p.id, p.name, p.openAssumptions, (p.assumptions ?? []).map((a) => [a.id, a.text, a.context, a.agent, a.at])])
  if (unchanged('assumptions', [panelState.aRepo, panelState.aLimit, data, resolvedKeys])) return
  const repos = projects.filter((p) => p.openAssumptions > 0 || p.id === panelState.aRepo)
  const items = []
  for (const p of projects) {
    if (panelState.aRepo !== 'all' && p.id !== panelState.aRepo) continue
    for (const a of p.assumptions ?? []) if (Number.isSafeInteger(a?.id)) items.push({ p, a, key: `${p.id}#${a.id}` })
  }
  // Answered ones stay in place with their result until the panel closes.
  for (const view of assumptionViews.values()) {
    if (view.resolved && !items.some((x) => x.key === view.key) && (panelState.aRepo === 'all' || view.p.id === panelState.aRepo)) items.push({ p: view.p, a: view.a, key: view.key })
  }
  items.sort((x, y) => (y.a.at ?? 0) - (x.a.at ?? 0) || x.key.localeCompare(y.key))

  const chips = h(
    'div',
    { class: 'chips', role: 'group', 'aria-label': 'Filter by repo' },
    chip('All', total, panelState.aRepo === 'all', () => {
      panelState.aRepo = 'all'
      renderAssumptions()
    }),
    repos.map((p) =>
      chip(p.name, p.openAssumptions ?? 0, panelState.aRepo === p.id, () => {
        panelState.aRepo = p.id
        panelState.aLimit = 20
        renderAssumptions()
      }),
    ),
  )
  if (!items.length) {
    const scoped = panelState.aRepo !== 'all' ? state.projects.get(panelState.aRepo) : null
    body.replaceChildren(
      repos.length ? chips : '',
      emptyBox('assumptions', 'halo', [
        [scoped ? `Nothing open in ${scoped.name}.` : 'Nothing to review.', 'When an agent decides something without asking you, it logs the assumption here.'],
        'Mark it right and the session that logged it hears so. Mark it wrong with a correction and every agent in that repo gets your correction as a rule.',
      ]),
    )
    return
  }
  const shown = items.slice(0, panelState.aLimit)
  const agents = new Map()
  for (const { a } of items) if (a.agent) agents.set(a.agent, (agents.get(a.agent) ?? 0) + 1)
  const byLine = [...agents].sort((x, y) => y[1] - x[1]).map(([agent, n]) => `${agentName(agent)} (${n})`)
  const parts = [chips, h('p', { class: 'by', text: `${byLine.length ? `Logged by ${listWords(byLine)}. ` : ''}Newest first.` })]
  const capped = projects.filter((p) => (panelState.aRepo === 'all' || p.id === panelState.aRepo) && (p.openAssumptions ?? 0) > (p.assumptions?.length ?? 0))
  if (capped.length) parts.push(h('p', { class: 'p-note', text: `Showing the newest ${capped.map((p) => `${p.assumptions.length} of ${p.openAssumptions} in ${p.name}`).join(', ')}. Answer some and older ones come in.` }))
  const list = h('ol', { class: 'a-list' })
  for (const item of shown) {
    let view = assumptionViews.get(item.key)
    if (!view) {
      view = makeAssumption(item.p, item.a)
      assumptionViews.set(item.key, view)
    }
    view.update(item.p, item.a)
    list.append(view.li)
  }
  parts.push(list)
  if (items.length > shown.length) {
    const more = h('button', { type: 'button', class: 'btn btn-s', text: `Show ${Math.min(20, items.length - shown.length)} more of ${items.length - shown.length}` })
    more.addEventListener('click', () => {
      const next = shown.length
      panelState.aLimit += 20
      renderAssumptions()
      // The first of the newly shown items takes the focus, so the list reads on from there.
      byId('p-assumptions-body').querySelectorAll('.a-item')[next]?.querySelector('button')?.focus()
    })
    parts.push(h('div', { class: 'more-btn' }, more))
  }
  body.replaceChildren(...parts)
}

// A filter chip. Choosing one redraws the panel, so the focus moves to the chip now pressed.
function chip(label, n, pressed, onClick) {
  const button = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(pressed) }, label, ' ', h('span', { text: String(n) }))
  button.addEventListener('click', () => {
    const body = button.closest('.panel-body')
    onClick()
    body?.querySelector('.chip[aria-pressed="true"]')?.focus()
  })
  return button
}

const listWords = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)
const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok', devin: 'Devin', cascade: 'Devin Cascade', you: 'you', user: 'you', dashboard: 'you', cli: 'you' }
const agentName = (agent) => AGENT_NAMES[agent] ?? String(agent ?? 'an agent')

function makeAssumption(p, a) {
  const key = `${p.id}#${a.id}`
  const text = h('p', { class: 'a-text' })
  const why = h('p', { class: 'a-ctx' })
  const meta = h('p', { class: 'a-meta' })
  const right = h('button', { type: 'button', class: 'btn btn-s', text: 'Mark right' })
  const wrong = h('button', { type: 'button', class: 'btn btn-s', 'aria-expanded': 'false', text: 'Mark wrong' })
  const acts = h('div', { class: 'a-acts' }, right, wrong)
  const fixId = uid('fix')
  const input = h('input', { type: 'text', id: fixId, maxLength: 500, autocomplete: 'off' })
  const submit = h('button', { type: 'submit', class: 'btn btn-s btn-ink', text: 'Mark wrong' })
  const cancel = h('button', { type: 'button', class: 'btn btn-s btn-quiet', text: 'Cancel' })
  const hint = h('p', { class: 'a-fix-hint' })
  const form = h('form', { class: 'a-fix', novalidate: true, hidden: true }, h('label', { for: fixId }, 'What is actually true? ', h('span', { text: 'Optional' })), input, hint, h('div', { class: 'a-acts' }, submit, cancel))
  const result = h('p', { class: 'a-result', role: 'status' })
  const li = h('li', { class: 'a-item' }, text, why, meta, acts, form, result)
  wrong.setAttribute('aria-controls', uid('fixform'))
  form.id = wrong.getAttribute('aria-controls')
  const view = { key, li, p, a, resolved: false }

  const busy = (on) => {
    for (const b of [right, wrong, submit, cancel]) b.disabled = on
  }
  async function send(verdict, fix) {
    busy(true)
    result.classList.remove('is-bad')
    result.textContent = 'Saving…'
    const r = await act('assumption.verdict', { projectId: view.p.id, id: Number(view.a.id), verdict, ...(fix ? { fix } : {}) })
    busy(false)
    result.textContent = r.text || (r.ok ? 'Saved.' : 'That did not work.')
    if (!r.ok) {
      result.classList.add('is-bad')
      return
    }
    view.resolved = true
    li.classList.add('is-resolved')
    acts.hidden = true
    form.hidden = true
    announce(verdict === 'right' ? 'Marked right.' : 'Marked wrong.')
  }
  right.addEventListener('click', () => send('right'))
  wrong.addEventListener('click', () => {
    form.hidden = false
    wrong.setAttribute('aria-expanded', 'true')
    input.focus()
  })
  cancel.addEventListener('click', () => {
    form.hidden = true
    wrong.setAttribute('aria-expanded', 'false')
    wrong.focus()
  })
  input.addEventListener('input', () => {
    submit.textContent = input.value.trim() ? 'Mark wrong and make a rule' : 'Mark wrong'
  })
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    send('wrong', input.value.trim())
  })

  view.update = (project, item) => {
    view.p = project
    view.a = item
    text.textContent = item.text ?? ''
    why.hidden = !item.context
    why.textContent = item.context ?? ''
    const repoLink = h('button', { type: 'button', class: 'link', text: project.name })
    repoLink.addEventListener('click', () => {
      panelState.aRepo = project.id
      renderAssumptions()
    })
    meta.replaceChildren(h('span', { text: item.agent ? agentName(item.agent) : 'An agent' }), repoLink, Number.isFinite(item.at) ? liveText(h('span'), item.at, agoWords) : null)
    hint.textContent = `With a correction, this becomes a rule for every agent in ${project.name}.`
    input.placeholder = 'The correction, in your own words'
  }
  return view
}

// --- ideas --------------------------------------------------------------------------------------

const ideaViews = new Map()

// The snapshot lists each project's newest ideas only; ideasCount is the whole shelf, open and
// taken. Open is the whole shelf less the taken ones listed: exact unless an idea older than the
// list was taken in the last two hours (a take lasts that long).
function ideaCounts(p) {
  const listed = Array.isArray(p.ideas) ? p.ideas : []
  const taken = listed.filter((i) => i.status === 'taken').length
  const total = Number.isFinite(p.ideasCount) ? Math.max(p.ideasCount, listed.length) : listed.length
  return { total, open: total - taken, taken, listed: listed.length }
}

function renderIdeas() {
  const projects = projectList()
  const openCount = projects.reduce((n, p) => n + ideaCounts(p).open, 0)
  setCount('p-ideas-count', openCount, 'on the shelf')
  const body = byId('p-ideas-body')
  if (panelState.iRepo !== 'all' && !state.projects.has(panelState.iRepo)) panelState.iRepo = 'all'
  const gone = [...ideaViews.values()].filter((v) => v.gone).map((v) => v.key)
  if (unchanged('ideas', [panelState.iRepo, projects.map((p) => [p.id, p.name, p.live > 0, p.actionable, p.openAssumptions, p.ideas, p.ideasCount]), gone])) return
  const shelved = (p) => ideaCounts(p).total
  const withIdeas = projects.filter((p) => shelved(p) || p.live > 0).sort((a, b) => shelved(b) - shelved(a) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  const shown = panelState.iRepo === 'all' ? withIdeas : projects.filter((p) => p.id === panelState.iRepo)
  const parts = []
  if (withIdeas.length > 1 || panelState.iRepo !== 'all') {
    parts.push(
      h(
        'div',
        { class: 'chips', role: 'group', 'aria-label': 'Filter by repo' },
        chip('All', openCount, panelState.iRepo === 'all', () => {
          panelState.iRepo = 'all'
          renderIdeas()
        }),
        withIdeas.map((p) =>
          chip(p.name, ideaCounts(p).open, panelState.iRepo === p.id, () => {
            panelState.iRepo = p.id
            renderIdeas()
          }),
        ),
      ),
    )
  }
  const capped = shown.filter((p) => ideaCounts(p).total > ideaCounts(p).listed)
  if (capped.length) {
    parts.push(h('p', { class: 'p-note', text: `Showing the newest ${capped.map((p) => `${ideaCounts(p).listed} of ${ideaCounts(p).total} in ${p.name}`).join(', ')}. Drop some and older ones come in.` }))
  }
  if (!shown.length || (!openCount && !projects.some((p) => p.ideas?.length) && !shown.some((p) => p.actionable))) {
    parts.push(
      emptyBox('ideas', 'wizard', [
        ['The shelf is empty.', 'When an agent spots something worth doing that you did not ask for, it shelves the idea here instead of chasing it.'],
        'Start a session in a repo to add your own ideas for it.',
      ]),
    )
    body.replaceChildren(...parts)
    return
  }
  const keep = new Set()
  for (const p of shown) {
    const ideas = p.ideas ?? []
    const section = h('section', { class: 'p-sec', 'aria-label': `Ideas for ${p.name}` })
    const head = h('h3', { class: 'p-sec-h' }, p.name, h('span', { class: 'n', text: String(ideaCounts(p).open) }))
    if (p.openAssumptions > 0) {
      const link = h('button', { type: 'button', class: 'link', text: `${plural(p.openAssumptions, 'open assumption')}` })
      link.addEventListener('click', () => openPanel('assumptions', { repo: p.id, from: link }))
      head.append(link)
    }
    section.append(head)
    if (p.actionable) section.append(addIdeaForm(p))
    if (!ideas.length) section.append(h('p', { class: 'd-empty', text: p.actionable ? `No ideas for ${p.name} yet.` : `No ideas for ${p.name}.` }))
    const list = h('ol')
    for (const idea of ideas) {
      const key = `${p.id}#${idea.id}`
      keep.add(key)
      let view = ideaViews.get(key)
      if (!view) {
        view = makeIdea(p, idea)
        ideaViews.set(key, view)
      }
      view.update(p, idea)
      list.append(view.li)
    }
    for (const view of ideaViews.values()) {
      if (view.p.id === p.id && view.gone && !keep.has(view.key)) {
        keep.add(view.key)
        list.append(view.li)
      }
    }
    section.append(list)
    parts.push(section)
  }
  for (const key of [...ideaViews.keys()]) if (!keep.has(key)) ideaViews.delete(key)
  body.replaceChildren(...parts)
}

const addForms = new Map()

function addIdeaForm(p) {
  let view = addForms.get(p.id)
  if (view) return view.form
  const inputId = uid('idea')
  const input = h('input', { type: 'text', id: inputId, maxLength: 300, autocomplete: 'off', placeholder: `Add an idea for ${p.name}` })
  const submit = h('button', { type: 'submit', class: 'btn btn-s', text: 'Shelve it' })
  const result = h('p', { class: 'i-add-result', role: 'status' })
  const form = h('form', { class: 'i-add', novalidate: true }, h('label', { class: 'vh', for: inputId, text: `Add an idea for ${p.name}` }), input, submit, result)
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) {
      result.textContent = 'Type the idea first: one line.'
      input.focus()
      return
    }
    submit.disabled = true
    const r = await act('idea.add', { projectId: p.id, text })
    submit.disabled = false
    result.textContent = r.text
    if (r.ok) input.value = ''
  })
  view = { form }
  addForms.set(p.id, view)
  return form
}

function makeIdea(p, idea) {
  const key = `${p.id}#${idea.id}`
  const text = h('p', { class: 'i-text' })
  const files = h('p', { class: 'i-files' })
  const meta = h('p', { class: 'a-meta' })
  const acts = h('div', { class: 'a-acts' })
  const result = h('p', { class: 'a-result', role: 'status' })
  const prompt = h('pre', { class: 'i-prompt', hidden: true })
  const li = h('li', { class: 'i-item' }, text, files, meta, acts, prompt, result)
  const view = { key, li, p, idea, gone: false, confirming: false, sig: '' }

  const copy = h('button', { type: 'button', class: 'btn btn-s' }, icon('copy'), h('span', { class: 'lbl', text: 'Copy prompt' }))
  const drop = h('button', { type: 'button', class: 'btn btn-s btn-quiet', text: 'Drop' })
  const putBack = h('button', { type: 'button', class: 'btn btn-s', text: 'Put back' })
  const ask = h('span', { class: 'a-acts-q', text: 'Drop this idea for good?' })
  const yes = h('button', { type: 'button', class: 'btn btn-s btn-danger', text: 'Drop' })
  const no = h('button', { type: 'button', class: 'btn btn-s btn-quiet', text: 'Keep' })

  copy.addEventListener('click', async () => {
    copy.disabled = true
    const r = await act('idea.prompt', { projectId: view.p.id, id: view.idea.id })
    copy.disabled = false
    if (!r.ok) {
      result.textContent = r.text
      return
    }
    const textToCopy = typeof r.body?.data?.prompt === 'string' ? r.body.data.prompt : r.text
    const ok = await copyText(textToCopy)
    if (ok) {
      prompt.hidden = true
      flash(copy, 'Copied. Paste it into any session.')
      result.textContent = ''
      announce('Prompt copied. Paste it into any session.')
    } else {
      prompt.hidden = false
      prompt.textContent = textToCopy
      result.textContent = 'The browser blocked the clipboard. Select the prompt above and copy it.'
    }
  })
  drop.addEventListener('click', () => {
    view.confirming = true
    paintActs()
    no.focus()
  })
  no.addEventListener('click', () => {
    view.confirming = false
    paintActs()
    drop.focus()
  })
  yes.addEventListener('click', async () => {
    yes.disabled = true
    const r = await act('idea.remove', { projectId: view.p.id, id: view.idea.id })
    yes.disabled = false
    result.textContent = r.text
    if (r.ok) {
      view.gone = true
      view.confirming = false
      li.classList.add('is-resolved')
      acts.replaceChildren()
      announce('Idea dropped.')
    }
  })
  putBack.addEventListener('click', async () => {
    putBack.disabled = true
    const r = await act('idea.restore', { projectId: view.p.id, id: view.idea.id })
    putBack.disabled = false
    result.textContent = r.text
  })

  function paintActs() {
    if (view.gone) return
    if (view.idea.status === 'taken') acts.replaceChildren(putBack)
    else if (view.confirming) acts.replaceChildren(ask, yes, no)
    else acts.replaceChildren(copy, drop)
  }

  // A taken idea says who took it and when; an open one who shelved it and when.
  view.update = (project, item) => {
    view.p = project
    view.idea = item
    const by = item.status === 'taken' && item.takenBy && typeof item.takenBy === 'object' ? item.takenBy : null
    const sig = JSON.stringify([item.text, item.files, item.status, item.source, item.createdAt, by])
    if (sig === view.sig) return
    view.sig = sig
    text.textContent = item.text ?? ''
    const list = Array.isArray(item.files) ? item.files : []
    files.hidden = !list.length
    // One span for the whole list, so the row's gap falls only after "Start in", never before a comma.
    files.replaceChildren(...(list.length ? ['Start in', h('span', {}, list.flatMap((f, i) => [i ? ', ' : '', h('code', { text: f })]))] : []))
    li.classList.toggle('is-taken', item.status === 'taken')
    if (item.status === 'taken') {
      const taker = by?.agentLabel || (by?.agent ? agentName(by.agent) : 'a session')
      meta.replaceChildren(Number.isFinite(by?.at) ? liveText(h('span'), by.at, (at) => `Taken by ${taker} ${agoWords(at)}`) : h('span', { text: `Taken by ${taker}` }))
    } else {
      meta.replaceChildren(h('span', { text: `Shelved by ${agentName(item.source)}` }), Number.isFinite(item.createdAt) ? liveText(h('span'), item.createdAt, agoWords) : null)
    }
    paintActs()
  }
  return view
}

// --- rules --------------------------------------------------------------------------------------

const ruleViews = new Map()

function renderRules() {
  const projects = projectList().filter((p) => p.rules?.length)
  const total = projects.reduce((n, p) => n + p.rules.length, 0)
  setCount('p-rules-count', total, 'made')
  const body = byId('p-rules-body')
  const gone = [...ruleViews.values()].filter((v) => v.gone).map((v) => v.key)
  if (unchanged('rules', [projectList().map((p) => [p.id, p.name, p.openAssumptions, p.rules]), gone])) return
  if (!total && ![...ruleViews.values()].some((v) => v.gone)) {
    const open = projectList().reduce((n, p) => n + (p.openAssumptions ?? 0), 0)
    const go = open ? h('button', { type: 'button', class: 'btn btn-s', text: `Review ${plural(open, 'assumption')}` }) : null
    go?.addEventListener('click', () => openPanel('assumptions', { from: go }))
    body.replaceChildren(
      emptyBox(
        'rules',
        'chef',
        [
          ['No rules yet.', 'A rule starts as an assumption you mark wrong, with a correction in your own words.'],
          'From then on, every session of every agent in that repo gets the rule at start, in any worktree.',
        ],
        go,
      ),
    )
    return
  }
  const keep = new Set()
  const parts = []
  for (const p of projects) {
    const head = h('h3', { class: 'p-sec-h' }, p.name, h('span', { class: 'n', text: String(p.rules.length) }))
    if (p.openAssumptions > 0) {
      const link = h('button', { type: 'button', class: 'link', text: plural(p.openAssumptions, 'open assumption') })
      link.addEventListener('click', () => openPanel('assumptions', { repo: p.id, from: link }))
      head.append(link)
    }
    const list = h('ol')
    for (const rule of p.rules) {
      const key = `${p.id}#${rule.id}`
      keep.add(key)
      let view = ruleViews.get(key)
      if (!view) {
        view = makeRule(p, rule)
        ruleViews.set(key, view)
      }
      view.update(p, rule)
      list.append(view.li)
    }
    for (const view of ruleViews.values()) {
      if (view.p.id !== p.id || !view.gone || keep.has(view.key)) continue
      keep.add(view.key)
      list.append(view.li)
    }
    parts.push(h('section', { class: 'p-sec', 'aria-label': `Rules for ${p.name}` }, head, list))
  }
  for (const key of [...ruleViews.keys()]) if (!keep.has(key)) ruleViews.delete(key)
  body.replaceChildren(...parts)
}

function makeRule(p, rule) {
  const fix = h('p', { class: 'r-text r-fix' })
  const was = h('p', { class: 'r-was' })
  const meta = h('p', { class: 'a-meta' })
  const acts = h('div', { class: 'a-acts' })
  const result = h('p', { class: 'a-result', role: 'status' })
  const li = h('li', { class: 'r-item' }, fix, was, meta, acts, result)
  const view = { key: `${p.id}#${rule.id}`, li, p, rule, gone: false }
  const del = h('button', { type: 'button', class: 'btn btn-s btn-quiet', text: 'Delete rule' })
  const ask = h('span', { class: 'a-acts-q' })
  const yes = h('button', { type: 'button', class: 'btn btn-s btn-danger', text: 'Delete' })
  const no = h('button', { type: 'button', class: 'btn btn-s btn-quiet', text: 'Keep' })
  del.addEventListener('click', () => {
    ask.textContent = `Delete this rule? Agents in ${view.p.name} stop getting it.`
    acts.replaceChildren(ask, yes, no)
    no.focus()
  })
  no.addEventListener('click', () => {
    acts.replaceChildren(del)
    del.focus()
  })
  yes.addEventListener('click', async () => {
    yes.disabled = true
    const r = await act('rule.delete', { projectId: view.p.id, id: Number(view.rule.id) })
    yes.disabled = false
    result.textContent = r.text
    if (r.ok) {
      view.gone = true
      li.classList.add('is-resolved')
      acts.replaceChildren()
    }
  })
  acts.append(del)
  view.update = (project, item) => {
    view.p = project
    view.rule = item
    fix.textContent = item.correction ?? ''
    was.textContent = `Instead of: ${item.assumption ?? ''}`
    meta.replaceChildren(h('span', { text: `Rule #${item.id}` }), Number.isFinite(item.at) ? liveText(h('span'), item.at, agoWords) : null)
  }
  return view
}

// --- decisions, messages ------------------------------------------------------------------------

function renderDecisions() {
  const projects = projectList().filter((p) => p.decisions?.length)
  const total = projects.reduce((n, p) => n + p.decisions.length, 0)
  setCount('p-decisions-count', total, 'remembered')
  const body = byId('p-decisions-body')
  if (unchanged('decisions', projects.map((p) => [p.id, p.name, p.decisions]))) return
  if (!total) {
    body.replaceChildren(
      emptyBox('decisions', 'crown', [
        ['None remembered yet.', 'When an agent asks you to pick a design direction, it opens the picker in your browser.'],
        'Your pick is saved for that repo, every agent builds with it, and it shows here grouped by repo.',
      ]),
    )
    return
  }
  body.replaceChildren(
    ...projects.map((p) =>
      h(
        'section',
        { class: 'p-sec', 'aria-label': `Design decisions for ${p.name}` },
        h('h3', { class: 'p-sec-h' }, p.name, h('span', { class: 'n', text: String(p.decisions.length) })),
        h(
          'ol',
          {},
          [...p.decisions]
            .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
            .map((d) =>
              h(
                'li',
                { class: 'dc-item' },
                h('p', { class: 'dc-q', text: d.question ?? '' }),
                h('p', { class: 'dc-choice', text: d.choice ?? '' }),
                d.description ? h('p', { class: 'dc-desc', text: d.description }) : null,
                h('p', { class: 'a-meta' }, d.topic ? h('span', { text: d.topic }) : null, d.agent ? h('span', { text: `Asked by ${agentName(d.agent)}` }) : null, Number.isFinite(d.at) ? liveText(h('span'), d.at, agoWords) : null),
              ),
            ),
        ),
      ),
    ),
  )
}

function renderMessages() {
  const withMail = state.sessions.filter((s) => s.state !== 'ended' && s.unread > 0).sort((a, b) => b.unread - a.unread || titleOf(a).localeCompare(titleOf(b)))
  const total = withMail.reduce((n, s) => n + s.unread, 0)
  setCount('p-messages-count', total, 'unread')
  const body = byId('p-messages-body')
  if (unchanged('messages', withMail.map((s) => [s.key, titleOf(s), s.unread, s.agent, repoOf(s)]))) return
  if (!withMail.length) {
    body.replaceChildren(
      emptyBox('messages', 'propeller', [['Nothing queued.', 'To send one, open a session in the list and use Send a message.']]),
    )
    return
  }
  body.replaceChildren(
    h(
      'ol',
      {},
      withMail.map((s) => {
        const open = h('button', { type: 'button', class: 'btn btn-s', text: 'Open session' })
        open.addEventListener('click', () => openMessage(s.key))
        return h(
          'li',
          { class: 'm-item' },
          h('div', { class: 'm-line' }, h('div', {}, h('p', { class: 'm-title', text: titleOf(s) }), h('p', { class: 'm-sub', text: `${s.agentLabel} in ${repoOf(s)} · ${plural(s.unread, 'unread message')} · ${deliveryText(s).replace(/^Arrives/, 'arrives').replace(/\.$/, '')}` })), open),
        )
      }),
    ),
    h('p', { class: 'p-note', text: 'This page counts unread messages without reading or taking them.' }),
  )
}

// --- activity -----------------------------------------------------------------------------------

const TOOL_WORDS = { shell: 'ran a command', read: 'read a file', search: 'searched the code', web: 'looked something up on the web', agent: 'called in a helper', ask: 'asked you a question', mcp: 'used an MCP tool', other: 'used a tool' }

function who(line) {
  if (line.agent && SPEAKERS[line.agent]) return SPEAKERS[line.agent]
  return line.agentLabel || (line.agent ? agentName(line.agent) : 'You')
}

function whatOf(line) {
  switch (line.ev) {
    case 'session.start':
      return line.hat ? `started (hat: ${line.hat})` : 'started'
    case 'prompt.submit':
      return 'new prompt'
    case 'tool.post':
      if (line.ok === false) return 'a tool failed'
      if (line.kind === 'edit') return line.label ? `edited ${line.label}` : 'edited a file'
      if (line.kind === 'todo') return 'updated its task list'
      return TOOL_WORDS[line.kind] ?? 'used a tool'
    case 'turn.stop':
      return 'turn finished'
    case 'notify':
      return 'needs you'
    case 'session.end':
      return 'ended'
    case 'clawd.cmd':
      return `Clawd: ${line.verb ?? 'command'}${line.verb === 'hat' && line.arg ? ` ${line.arg}` : ''}`
    default:
      return line.ev
  }
}

let activitySig = ''

function renderActivity() {
  const body = byId('p-activity-body')
  const lines = [...state.activity].reverse()
  const sig = `${lines.length}|${lines[0] ? lineSig(lines[0]) : ''}`
  if (sig === activitySig && body.childElementCount) return
  activitySig = sig
  if (!lines.length) {
    body.replaceChildren(emptyBox('activity', 'santa', [['Quiet for 30 minutes.', 'Every hook event from every agent lands here as it happens: prompts, edits, finished turns, sessions that need you.']]))
    return
  }
  body.replaceChildren(
    h(
      'ol',
      { class: 'feed' },
      lines.map((line) =>
        h(
          'li',
          {},
          h(
            'span',
            { class: 'f-l' },
            line.ev === 'notify' ? h('span', { class: 'f-q', 'aria-hidden': 'true', text: '?' }) : null,
            h('span', { class: 'f-a', text: who(line) }),
            line.project ? [h('span', { class: 'f-dot', text: ' · ' }), line.project] : null,
            h('span', { class: 'f-dot', text: ' · ' }),
            h('span', { class: line.ok === false ? 'f-bad' : null, text: whatOf(line) }),
            h('span', { class: 'f-dot', text: ' · ' }),
            liveText(h('span'), line.t, (at) => `${ago(at)} ago`),
          ),
        ),
      ),
    ),
  )
}

// --- health -------------------------------------------------------------------------------------

// Silent means one session says it is working and its last hook (`since`) is more than 15 minutes
// old. Finished, waiting and open sessions fire no hooks by design, so they are never flagged
// however long they sit; a long tool run can also be quiet that long, so the words allow for it.
const silentMinutes = (at) => `${Math.floor(Math.max(0, serverNow() - at) / 60_000)} min`

function healthIssues() {
  const agents = Array.isArray(state.snap?.health?.agents) ? state.snap.health.agents : []
  const now = serverNow()
  const silent = state.sessions
    .filter((s) => s.state === 'working' && Number.isFinite(s.since) && now - s.since > SILENT_MS)
    .sort((a, b) => a.since - b.since || a.key.localeCompare(b.key))
    .map((s) => ({ session: s, who: `${s.agentLabel ?? agentName(s.agent)} '${titleOf(s)}'` }))
  const seen = agents.filter((a) => Number.isFinite(a.lastSeen)).sort((x, y) => y.lastSeen - x.lastSeen)
  const summary = seen.length ? `Last hook ${agoWords(seen[0].lastSeen)}, from ${seen[0].label}` : 'No hook seen yet'
  return { agents, silent, summary }
}

function renderHealth() {
  const health = state.snap?.health ?? {}
  const { agents, silent } = healthIssues()
  const errors = health.errors ?? { count: 0 }
  byId('p-health-count').textContent = errors.count ? plural(errors.count, 'error') : 'no errors'
  const parts = []
  if (silent.length) {
    parts.push(
      h(
        'div',
        { class: 'warn', role: 'note' },
        silent.map((x) =>
          h(
            'p',
            {},
            `${x.who} says it is working but no hook for `,
            liveText(h('span'), x.session.since, silentMinutes),
            '. A long tool run is normal; otherwise its hooks may have stopped (',
            h('code', { text: 'agent-mods doctor --deep' }),
            ').',
          ),
        ),
      ),
    )
  }
  parts.push(
    h(
      'table',
      { class: 'hooks' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Agent' }), h('th', { scope: 'col', text: 'Live sessions' }), h('th', { scope: 'col', text: 'Last hook seen' }))),
      h(
        'tbody',
        {},
        agents.map((a) => {
          const quiet = silent.filter((x) => x.session.agent === a.agent).length
          const isSilent = quiet > 0
          return h(
            'tr',
            {},
            h('th', { scope: 'row', text: a.label }),
            h('td', { class: 'num', text: String(a.live ?? 0) }),
            h('td', { class: isSilent ? 'num is-silent' : 'num' }, Number.isFinite(a.lastSeen) ? liveText(h('span'), a.lastSeen, agoWords) : 'never', isSilent ? ` · ${quiet} working, quiet` : ''),
          )
        }),
      ),
    ),
  )
  const errorSection = h('section', { class: 'p-sec p-sec-gap' }, h('h3', { class: 'p-sec-h', text: 'Error log' }))
  if (errors.count) {
    errorSection.append(
      h('p', { class: 'set-hint' }, `${plural(errors.count, 'entry', 'entries')} in `, h('code', { text: 'logs/errors.log' }), errors.lastAt ? [', the last ', liveText(h('span'), errors.lastAt, agoWords), ':'] : ':'),
      errors.last ? h('pre', { class: 'err-line', text: errors.last }) : null,
    )
  } else {
    errorSection.append(emptyBox('errors', 'halo', [['No errors.', 'When a hook or the dashboard fails, the agent-mods error log (logs/errors.log) gets the entry and it shows here.']]))
  }
  parts.push(errorSection)
  const facts = []
  if (health.store) facts.push(h('p', {}, 'Store: ', h('code', { text: health.store })))
  if (health.server) facts.push(h('p', {}, `Dashboard process ${health.server.pid ?? '?'} on port ${health.server.port ?? '?'}, started `, Number.isFinite(health.server.startedAt) ? liveText(h('span'), health.server.startedAt, agoWords) : 'at an unknown time', '.'))
  if (facts.length) parts.push(h('div', { class: 'facts' }, facts))
  byId('p-health-body').replaceChildren(...parts)
}

// --- settings -----------------------------------------------------------------------------------

const settingsUi = { built: false }

function buildSettings() {
  if (settingsUi.built) return
  settingsUi.built = true
  for (const input of document.querySelectorAll('#plain-seg input')) {
    input.addEventListener('change', async () => {
      if (!input.checked) return
      const result = byId('plain-result')
      setDisabled('#plain-seg input', true)
      const r = await act('plain', { level: input.value })
      setDisabled('#plain-seg input', false)
      showResult(result, r)
      // Refused: the server kept the old level, so the old option goes back on.
      if (!r.ok) renderSettings()
    })
  }
  byId('alerts-switch').addEventListener('click', async () => {
    const button = byId('alerts-switch')
    const on = button.getAttribute('aria-checked') !== 'true'
    button.disabled = true
    const r = await act('notify', { enabled: on })
    button.disabled = false
    showResult(byId('alerts-result'), r)
    if (r.ok) setSwitch(button, on, on ? 'On' : 'Off')
  })
  const hats = byId('hats')
  const group = uid('hat')
  const options = [['random', 'Random'], ...PICKABLE_HATS.map((hat) => [hat, hat])]
  for (const [value, text] of options) {
    const id = uid('hatopt')
    const input = h('input', { type: 'radio', name: group, id, value })
    const art =
      value === 'random'
        ? h('span', { class: 'tile tile-hat tile-random', 'aria-hidden': 'true', text: '?' })
        : pets.still(`hat:${value}`, { hat: value, mood: 'idle', kind: 'hat' })
    const label = h('label', { for: id }, art, h('span', { text }))
    input.addEventListener('change', async () => {
      if (!input.checked) return
      setDisabled('#hats input', true)
      const r = await clawd('hat', null, null, null, value)
      setDisabled('#hats input', false)
      showResult(byId('hat-result'), r)
      if (!r.ok) renderSettings()
    })
    hats.append(input, label)
  }
  byId('shades-switch').addEventListener('click', async () => {
    const button = byId('shades-switch')
    button.disabled = true
    const r = await clawd('shades', null, null, null)
    button.disabled = false
    showResult(byId('shades-result'), r)
    if (r.ok) {
      const on = Boolean(r.body?.data?.prefs?.shades)
      setSwitch(button, on, on ? 'On' : 'Off')
      byId('shades-tile').replaceChildren(pets.still('shades-preview', { hat: 'tophat', mood: 'idle', shades: on, label: on ? 'Clawd in shades' : 'Clawd without shades' }))
    }
  })
  byId('panes-switch').addEventListener('click', async () => {
    const button = byId('panes-switch')
    const show = button.getAttribute('aria-checked') !== 'true'
    button.disabled = true
    const r = await clawd(show ? 'show' : 'hide', null, null, null)
    button.disabled = false
    showResult(byId('panes-result'), r)
    if (r.ok) setSwitch(button, show, show ? 'Shown' : 'Hidden')
  })
}

function setDisabled(selector, on) {
  for (const el of document.querySelectorAll(selector)) el.disabled = on
}

function setSwitch(button, on, text) {
  button.setAttribute('aria-checked', String(on))
  button.querySelector('.sw-text').textContent = text
}

function showResult(el, r) {
  el.textContent = r.text || (r.ok ? 'Saved.' : 'That did not work.')
  el.classList.toggle('is-bad', !r.ok)
}

function renderSettings() {
  buildSettings()
  const settings = state.snap?.settings ?? {}
  const level = settings.plain?.level ?? 'off'
  for (const input of document.querySelectorAll('#plain-seg input')) if (!input.disabled) input.checked = input.value === level
  const notify = settings.notify ?? {}
  const alerts = byId('alerts-switch')
  if (!alerts.disabled) setSwitch(alerts, Boolean(notify.enabled), notify.enabled ? 'On' : 'Off')
  const after = Math.round((Number.isFinite(notify.afterMs) ? notify.afterMs : 30_000) / 1000)
  byId('alerts-after').textContent = `For turns longer than ${after} s${notify.sound === false ? ', without sound' : ', with sound'}.`
  const clawdPrefs = settings.clawd ?? {}
  const pinned = clawdPrefs.hat ?? 'random'
  for (const input of document.querySelectorAll('#hats input')) if (!input.disabled) input.checked = input.value === pinned
  const shades = byId('shades-switch')
  if (!shades.disabled) setSwitch(shades, Boolean(clawdPrefs.shades), clawdPrefs.shades ? 'On' : 'Off')
  byId('shades-tile').replaceChildren(pets.still('shades-preview', { hat: 'tophat', mood: 'idle', shades: Boolean(clawdPrefs.shades), label: clawdPrefs.shades ? 'Clawd in shades' : 'Clawd without shades' }))
  const panes = byId('panes-switch')
  if (!panes.disabled) setSwitch(panes, !clawdPrefs.hidden, clawdPrefs.hidden ? 'Hidden' : 'Shown')
}

// ================================================================================================
// Render all, keyboard, layout measurements
// ================================================================================================

// Each part on its own: a value one part did not expect must not stop the others from updating.
function render() {
  if (!state.snap) return
  keepFocus(() => {
    for (const part of [renderHeader, renderNeeds, renderList, renderRail, renderPanel]) {
      try {
        part()
      } catch (err) {
        console.error(`dashboard: ${part.name} failed`, err)
      }
    }
  })
}

// An update can move the element that has the focus (a row changing group, a panel item being
// re-placed); the focus, and the text cursor in a box being typed in, go back where they were.
function keepFocus(fn) {
  const active = document.activeElement
  let range = null
  try {
    if (active && typeof active.selectionStart === 'number') range = [active.selectionStart, active.selectionEnd]
  } catch {}
  fn()
  if (!active || active === document.body || active === document.activeElement || !active.isConnected) return
  active.focus({ preventScroll: true })
  if (range) {
    try {
      active.setSelectionRange(range[0], range[1])
    } catch {}
  }
}

function measureTop() {
  const top = byId('top')
  if (top) document.documentElement.style.setProperty('--top-h', `${top.offsetHeight}px`)
}

function keyOfFocus() {
  const active = document.activeElement
  if (!active) return null
  for (const [key, view] of rowViews) if (view.li.contains(active)) return key
  for (const [key, view] of detailViews) if (view.root.contains(active)) return key
  return null
}

// Esc steps out one level at a time: out of a correction box, out of a text box that holds typing
// (which closing the panel would lose), then the panel, then an expanded row.
function escapeInPanel(target) {
  if (!(target instanceof HTMLElement) || !target.closest('.panel')) return false
  const fix = target.closest('.a-fix')
  if (fix && !fix.hidden) {
    fix.querySelector('button[type="button"]')?.click()
    return true
  }
  if (target instanceof HTMLInputElement && target.type === 'text' && target.value.trim()) {
    target.closest('.panel')?.querySelector('h2')?.focus()
    return true
  }
  return false
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return
  if (openPanelName) {
    e.preventDefault()
    if (!escapeInPanel(e.target)) closePanel()
    return
  }
  const key = keyOfFocus() ?? (state.expanded.has(state.lastExpanded) ? state.lastExpanded : null)
  if (!key || !state.expanded.has(key)) return
  e.preventDefault()
  toggle(key, false)
  const s = state.byKey.get(key)
  if (s?.state === 'waiting') (key === needs.key ? needs.show : needs.rows.get(key)?.show)?.focus()
  else rowViews.get(key)?.hit.focus()
})

// ================================================================================================
// Boot
// ================================================================================================

function boot() {
  for (const button of document.querySelectorAll('.ri[data-panel]')) button.addEventListener('click', () => openPanel(button.dataset.panel, { from: button }))
  for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', closePanel)
  byId('scope').addEventListener('change', (e) => setScope(e.target.value))
  byId('show-ended').addEventListener('click', () => {
    prefs.showEnded = !prefs.showEnded
    store.set('showEnded', prefs.showEnded ? '1' : '0')
    render()
  })
  byId('done-more-btn').addEventListener('click', () => {
    state.showAllDone = !state.showAllDone
    render()
  })
  byId('t-notify').addEventListener('click', toggleNotify)
  byId('t-sound').addEventListener('click', toggleSound)
  renderTools()
  if (prefs.sound) unlockSoundOnFirstGesture()
  sheetQuery?.addEventListener?.('change', applySheet)
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => measureTop()).observe(byId('top'))
    new ResizeObserver(fitAll).observe(byId('sessions'))
  }
  measureTop()
  window.setInterval(() => {
    tickTexts()
    tickConn()
    for (const s of state.sessions) {
      if (s.state === 'idle' && serverNow() - s.since < RECENT_MS) pets.celebrate(s.key, s.since)
      else if (s.state === 'waiting') pets.attend(s.key)
    }
  }, 1000)
  // The remembered panel opens again only beside the list: as a full-screen sheet it would hide the
  // needs-you dialog on every load. It stays remembered for a wider window.
  if (prefs.panel && !isSheetLayout()) openPanel(prefs.panel, { focus: false })
  setConn('connecting')
  connect()
}

boot()
