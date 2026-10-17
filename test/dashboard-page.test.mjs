// The dashboard page itself (lib/dashboard/public): what its CSP allows, what it may import and
// fetch, that both scripts parse, that every file index.html references is really served, and the
// pets' bookkeeping (pets.js) driven the way the page drives it. No browser and no real store: the
// server runs in this process on port 0 with fake data, and pets.js runs against a bare document.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startDashboard } from '../lib/dashboard/server.mjs'
import { tempDir, tempStore } from './helpers.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const PUBLIC = path.join(ROOT, 'lib', 'dashboard', 'public')
const MODS = path.join(ROOT, 'lib', 'mods')
const SCRIPTS = ['app.js', 'pets.js']
const ALLOWED_IMPORTS = new Set(['./pets.js', './clawd-world.mjs', './clawd-sprite.mjs'])
const ALLOWED_PATHS = new Set(['/api/action', '/api/brief', '/api/resume', '/api/snapshot', '/healthz', '/events', '/done.wav'])
const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345'
const NOW = Date.UTC(2026, 9, 12, 8, 0, 0)

const read = (name) => fs.readFileSync(path.join(PUBLIC, name), 'utf8')

// Every module specifier in a source: static imports and re-exports, side-effect imports, and the
// argument of each dynamic import() as written.
function specifiers(source) {
  const out = []
  for (const m of source.matchAll(/\bfrom\s*(['"])([^'"]+)\1/g)) out.push(m[2])
  for (const m of source.matchAll(/(?:^|[;\n])\s*import\s*(['"])([^'"]+)\1/g)) out.push(m[2])
  for (const m of source.matchAll(/\bimport\s*\(([^)]*)\)/g)) out.push(m[1].trim())
  return out
}

// ---------------------------------------------------------------- static checks

// The page's own Trusted Types policy: with it the browser refuses every HTML-parsing sink (innerHTML
// under any spelling, DOMParser, srcdoc, insertAdjacentHTML) and string-to-code call at run time,
// which a source scan alone cannot promise. The server's CSP header adds script/style/connect rules.
const TRUSTED_TYPES = /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=["']require-trusted-types-for 'script'; trusted-types 'none'["']\s*\/?>/i

test('app.js and pets.js never build HTML from strings or run strings as code', () => {
  const banned = [
    [/\binnerHTML\b/, 'innerHTML'],
    [/\bouterHTML\b/, 'outerHTML'],
    [/\binsertAdjacentHTML\b/, 'insertAdjacentHTML'],
    [/\bcreateContextualFragment\b/, 'createContextualFragment'],
    [/\bdocument\s*\.\s*write(?:ln)?\b/, 'document.write'],
    [/\beval\b/, 'eval, called or passed'],
    [/\bnew\s+Function\b/, 'new Function'],
    [/(?<![\w$.])Function\s*\(/, 'Function()'],
    [/\.\s*constructor\s*\(/, 'a constructor called as a function (Function by another name)'],
    [/\bset(?:Timeout|Interval)\s*\(\s*['"`]/, 'a timer with code as a string'],
    [/\bsetAttribute\s*\(\s*['"`]style['"`]/i, "setAttribute('style')"],
    [/\bsetAttribute\s*\(\s*['"`]on[a-z]+['"`]/i, 'an inline handler set as an attribute'],
    [/\bDOMParser\b/, 'DOMParser'],
    [/\bparseFromString\b/, 'parseFromString'],
    [/\b(?:set|parse)HTMLUnsafe\b/, 'setHTMLUnsafe or parseHTMLUnsafe'],
    [/\bsrcdoc\b/i, 'srcdoc'],
    [/\bcreateHTMLDocument\b/, 'createHTMLDocument'],
    [/\[\s*['"`][^\]]*(?:HTML|write|eval|Function)[^\]]*\]/, 'a banned name reached by bracket access'],
    [/\bWebSocket\b/, 'WebSocket'],
    [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
    [/\bsendBeacon\b/, 'sendBeacon'],
  ]
  for (const name of SCRIPTS) {
    const source = read(name)
    for (const [pattern, what] of banned) assert.ok(!pattern.test(source), `${name} uses ${what}`)
  }
})

test('index.html turns on Trusted Types before anything loads', () => {
  const html = read('index.html')
  const meta = TRUSTED_TYPES.exec(html)
  assert.ok(meta, "the page carries require-trusted-types-for 'script' with no policy allowed")
  const head = html.slice(0, html.search(/<\/head>/i))
  const first = Math.min(...['<script', '<link'].map((tag) => head.indexOf(tag)).filter((at) => at >= 0))
  assert.ok(meta.index < first, 'the policy comes before every script and stylesheet')
})

test('app.css loads nothing from outside the page', () => {
  const css = read('app.css')
  const targets = [
    ...[...css.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)].map((m) => m[2]),
    ...[...css.matchAll(/@import\s+(['"])([^'"]*)\1/gi)].map((m) => m[2]),
  ]
  for (const target of targets) {
    const outside = /^[a-z][a-z0-9+.-]*:/i.test(target) ? !/^data:/i.test(target) : target.startsWith('//')
    assert.ok(!outside, `app.css loads ${target}`)
  }
})

test('index.html has no inline script, style or handler, and loads app.js as a module and app.css', () => {
  const html = read('index.html')
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
  assert.ok(scripts.length >= 1, 'the page has its script')
  for (const [, attrs, body] of scripts) {
    assert.match(attrs, /\bsrc\s*=/i, 'every script comes from a file')
    assert.equal(body.trim(), '', 'no inline script body')
  }
  const app = scripts.find(([, attrs]) => /\bsrc\s*=\s*["']?(?:\.\/|\/)?app\.js["'\s>]/i.test(`${attrs}>`))
  assert.ok(app, 'app.js is loaded')
  assert.match(app[1], /\btype\s*=\s*["']?module\b/i, 'as an ES module')
  assert.match(html, /<link\b[^>]*\brel=["']?stylesheet\b[^>]*\bhref=["']?(?:\.\/|\/)?app\.css\b/i)
  assert.ok(!/<style\b/i.test(html), 'no <style>')
  assert.ok(!/\sstyle\s*=/i.test(html), 'no style= attribute')
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no on...= attribute')
  assert.ok(!/javascript:/i.test(html), 'no javascript: URL')
})

test('app.js imports only ./pets.js, and pets.js only the Clawd world and sprite', () => {
  const app = specifiers(read('app.js'))
  const pets = specifiers(read('pets.js'))
  for (const [name, list] of [['app.js', app], ['pets.js', pets]]) {
    for (const spec of list) assert.ok(ALLOWED_IMPORTS.has(spec), `${name} imports ${spec}`)
  }
  assert.deepEqual([...new Set(app)], ['./pets.js'])
  assert.deepEqual([...new Set(pets)].sort(), ['./clawd-sprite.mjs', './clawd-world.mjs'])
})

test('the page asks the server only for its own API routes, and loads nothing from elsewhere', () => {
  for (const name of SCRIPTS) {
    const source = read(name)
    const asked = [...source.matchAll(/\b(?:fetch|call|EventSource|Audio)\s*\(\s*(['"`])([^'"`]*)/g)].map((m) => m[2])
    for (const target of asked) {
      const route = target.split('?')[0]
      assert.ok(ALLOWED_PATHS.has(route), `${name} asks for ${target}`)
    }
    const urls = [...source.matchAll(/(['"`])(https?:\/\/[^'"`]*)\1/g)].map((m) => m[2])
    assert.deepEqual(urls.filter((u) => u !== 'http://www.w3.org/2000/svg'), [], `${name} names an outside URL`)
  }
  const app = read('app.js')
  for (const route of ['/events', '/api/action', '/api/resume', '/healthz']) assert.ok(app.includes(`'${route}`) || app.includes(`\`${route}`), `app.js uses ${route}`)
})

test('app.js and pets.js parse (node --check)', () => {
  for (const name of SCRIPTS) {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(PUBLIC, name)], { stdio: 'pipe' }), name)
  }
})

// ---------------------------------------------------------------- served by the real server

function get(server, target) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: server.port, path: target, agent: false, setHost: false, headers: { host: `127.0.0.1:${server.port}`, cookie: `amdash=${TOKEN}` } },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] ?? '', text: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

test('every script, stylesheet and icon index.html references answers 200, and so does everything they import', async (t) => {
  const { store, env } = tempStore()
  const server = await startDashboard({
    store,
    env,
    port: 0,
    token: TOKEN,
    watch: false,
    clock: () => NOW,
    intervalMs: 1000,
    build: (_store, { now }) => ({ v: 1, at: now, sessions: [], counts: {}, clashes: [], projects: [], settings: {}, health: {} }),
    signature: () => '1',
    act: () => ({ status: 200, ok: true, text: 'Done.' }),
    activity: () => ({ seed: () => [], read: () => [], recent: () => [] }),
  })
  t.after(() => server.close())

  const page = await get(server, '/')
  assert.equal(page.status, 200)
  assert.equal(page.text, read('index.html'), 'the real page is served')
  const refs = [
    ...[...page.text.matchAll(/<script\b[^>]*\bsrc=["']?([^"'\s>]+)/gi)].map((m) => ['script', m[1]]),
    ...[...page.text.matchAll(/<link\b[^>]*>/gi)].flatMap(([tag]) => {
      const href = /\bhref=["']?([^"'\s>]+)/i.exec(tag)?.[1]
      const rel = /\brel=["']?([^"'>]+)/i.exec(tag)?.[1] ?? ''
      return href ? [[/stylesheet/i.test(rel) ? 'style' : 'other', href]] : []
    }),
  ]
  assert.ok(refs.some(([kind]) => kind === 'script'), 'the page references its script')
  assert.ok(refs.some(([kind]) => kind === 'style'), 'the page references its stylesheet')
  const types = { script: /^text\/javascript/, style: /^text\/css/ }
  const modules = []
  for (const [kind, href] of refs) {
    const target = new URL(href, 'http://127.0.0.1/').pathname
    const r = await get(server, target)
    assert.equal(r.status, 200, `${kind} ${href}`)
    if (types[kind]) assert.match(r.type, types[kind], `${kind} ${href} type`)
    if (kind === 'script') modules.push([target, r.text])
  }
  // Follow the module graph the browser will load.
  const seen = new Set(modules.map(([target]) => target))
  while (modules.length) {
    const [from, text] = modules.shift()
    for (const spec of specifiers(text)) {
      const target = new URL(spec, `http://127.0.0.1${from}`).pathname
      if (seen.has(target)) continue
      seen.add(target)
      const r = await get(server, target)
      assert.equal(r.status, 200, `${from} imports ${spec}`)
      assert.match(r.type, /^text\/javascript/, `${spec} type`)
      modules.push([target, r.text])
    }
  }
  for (const target of ['/pets.js', '/clawd-world.mjs', '/clawd-sprite.mjs']) assert.ok(seen.has(target), `${target} is part of the page`)
  const wav = await get(server, '/done.wav')
  assert.equal(wav.status, 200, 'the needs-you sound is served')
})

// ---------------------------------------------------------------- pets.js, the way the page drives it

// pets.js beside the two modules it imports, as the server lays them out, loaded with a document
// that has nothing but what createPets touches when no tile is drawn.
async function loadPets() {
  const dir = tempDir('am-page-')
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }\n')
  fs.copyFileSync(path.join(PUBLIC, 'pets.js'), path.join(dir, 'pets.js'))
  fs.copyFileSync(path.join(MODS, 'clawd-world.mjs'), path.join(dir, 'clawd-world.mjs'))
  fs.copyFileSync(path.join(MODS, 'clawd-sprite.mjs'), path.join(dir, 'clawd-sprite.mjs'))
  globalThis.document ??= { hidden: true, addEventListener() {} }
  return import(pathToFileURL(path.join(dir, 'pets.js')).href)
}

const session = (key, state, extra = {}) => ({ key, state, hat: 'wizard', since: NOW - 120_000, ...extra })
const line = (key, ev, extra = {}) => ({ t: NOW, agent: 'codex', agentLabel: 'Codex', key, projectId: 'shop-1234abcd', project: 'shop', ev, ...extra })

test('pets: a session the snapshot says is waiting asks "your call" even when no event said so', async () => {
  const { createPets, ASK_BUBBLE } = await loadPets()
  const pets = createPets({ clock: () => NOW, rand: () => 0 })
  pets.sync([session('claude__w1', 'waiting')], {})
  assert.equal(pets.bubbleOf('claude__w1'), ASK_BUBBLE)
  assert.equal(pets.hatOf('claude__w1'), 'wizard', "the pet wears the session's own hat")
})

test('pets: activity lines (key, projectId) drive the world, which takes over the page-made pet', async () => {
  const { createPets } = await loadPets()
  const pets = createPets({ clock: () => NOW, rand: () => 0 })
  pets.sync([session('codex__c1', 'working', { hat: 'propeller' })], {})
  assert.equal(pets.bubbleOf('codex__c1'), '', 'a page-made working pet says nothing yet')
  pets.feed([line('codex__c1', 'tool.post', { kind: 'edit', label: 'overlay.ts', ok: true })])
  assert.match(pets.bubbleOf('codex__c1'), /overlay\.ts/, 'the edit reached the pet through key -> sid')
  assert.equal(pets.hatOf('codex__c1'), 'propeller')
})

test('pets: the connect-time lines place pets without replaying old animations; the last minute plays', async () => {
  const { createPets } = await loadPets()
  const pets = createPets({ clock: () => NOW, rand: () => 0 })
  pets.sync([session('codex__s1', 'idle', { hat: null })], {})
  pets.seed([line('codex__s1', 'session.start', { t: NOW - 600_000, hat: 'chef' }), line('codex__s1', 'prompt.submit', { t: NOW - 590_000 })])
  assert.equal(pets.hatOf('codex__s1'), 'chef', 'the hat from the log')
  assert.equal(pets.bubbleOf('codex__s1'), '', 'no "hi!" or "on it!" replayed from ten minutes ago')
  pets.seed([line('codex__s1', 'turn.stop', { t: NOW - 5000 })])
  assert.notEqual(pets.bubbleOf('codex__s1'), '', 'a turn that finished seconds ago still celebrates')
})

test('pets: a command played on the page is not played a second time when its log line arrives', async () => {
  const { createPets } = await loadPets()
  let r = 0
  const pets = createPets({ clock: () => NOW, rand: () => r })
  pets.sync([session('codex__p1', 'working')], {})
  pets.feed([line('codex__p1', 'prompt.submit')])
  pets.play('codex__p1', { verb: 'pet', arg: '', ok: true, hat: 'wizard' })
  const said = pets.bubbleOf('codex__p1')
  r = 0.99
  pets.feed([line('codex__p1', 'clawd.cmd', { agent: 'dashboard', verb: 'pet', arg: '', hat: 'wizard' })])
  assert.equal(pets.bubbleOf('codex__p1'), said, 'the echo is skipped')
  pets.feed([line('codex__p1', 'clawd.cmd', { agent: 'dashboard', verb: 'pet', arg: '', hat: 'wizard', t: NOW + 1 })])
  assert.notEqual(pets.bubbleOf('codex__p1'), said, 'a second command from elsewhere still plays')
})

// ---------------------------------------------------------------- pets.js drawing, against a fake page

// A document with just what pets.js draws with: elements that are always connected, and canvases
// whose 2D context counts its fillRect calls. Timers are captured instead of run, so a test steps
// the clock itself; an IntersectionObserver is there only when a test asks for one.
function fakePage({ hidden = true, observer = false } = {}) {
  const counts = { fillRect: 0, canvases: 0 }
  const listeners = new Map()
  const timers = []
  const observers = []
  const element = (tag) => {
    const attrs = new Map()
    const el = {
      tagName: tag.toUpperCase(),
      className: '',
      isConnected: true,
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getAttribute: (k) => attrs.get(k) ?? null,
      removeAttribute: (k) => attrs.delete(k),
      append() {},
    }
    if (tag === 'canvas') {
      counts.canvases += 1
      const ctx = { imageSmoothingEnabled: true, fillStyle: '', fillRect: () => (counts.fillRect += 1), clearRect() {} }
      el.getContext = () => ctx
    }
    return el
  }
  const saved = { document: globalThis.document, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, IntersectionObserver: globalThis.IntersectionObserver }
  const doc = {
    hidden,
    createElement: element,
    addEventListener: (type, fn) => listeners.set(type, fn),
    fire: (type) => listeners.get(type)?.(),
  }
  globalThis.document = doc
  globalThis.setInterval = (fn, ms) => timers.push({ fn, ms, on: true })
  globalThis.clearInterval = (id) => {
    if (timers[id - 1]) timers[id - 1].on = false
  }
  if (observer) {
    globalThis.IntersectionObserver = class {
      constructor(callback) {
        this.callback = callback
        observers.push(this)
      }
      observe() {}
      unobserve() {}
    }
  } else delete globalThis.IntersectionObserver
  const running = () => timers.filter((t) => t.on)
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) for (const t of running()) t.fn()
  }
  const restore = () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name]
      else globalThis[name] = value
    }
  }
  return { doc, counts, timers, running, tick, observers, restore }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('pets: a tile is drawn when its cells change and never again for the same frame', async (t) => {
  const { createPets } = await loadPets()
  const page = fakePage({ hidden: false })
  t.after(page.restore)
  const pets = createPets({ clock: () => NOW, rand: () => 0 })
  pets.sync([session('codex__d1', 'working')], {})
  pets.tile('row:codex__d1', 'codex__d1', 'work')
  await flush()
  const first = page.counts.fillRect
  assert.ok(first > 0, 'the new tile is drawn once')
  pets.sync([session('codex__d1', 'working')], {})
  pets.sync([session('codex__d1', 'working')], {})
  assert.equal(page.counts.fillRect, first, 'an update that leaves the frame as it was draws nothing')
  page.tick(4)
  assert.ok(page.counts.fillRect > first, 'a working pet paces, so the clock draws it again')
})

test('pets: under reduced motion a pacing pet stays one still frame, on a once-a-second clock', async (t) => {
  const { createPets } = await loadPets()
  const page = fakePage({ hidden: false })
  t.after(page.restore)
  const pets = createPets({ clock: () => NOW, reduced: true, rand: () => 0 })
  assert.deepEqual(page.running().map((x) => x.ms), [1000], 'one clock, once a second')
  pets.sync([session('codex__r1', 'working')], {})
  pets.tile('row:codex__r1', 'codex__r1', 'work')
  await flush()
  const still = page.counts.fillRect
  assert.ok(still > 0)
  page.tick(6)
  assert.equal(page.counts.fillRect, still, 'sixty ticks of pacing draw nothing new')
  pets.sync([session('codex__r1', 'waiting')], {})
  assert.ok(page.counts.fillRect > still, 'a new state draws its one new frame')
  pets.setReduced(false)
  assert.deepEqual(page.running().map((x) => x.ms), [100], 'motion back: the 100 ms clock')
})

test('pets: the same id always returns the same tile, and a hidden page starts no clock', async (t) => {
  const { createPets } = await loadPets()
  const page = fakePage({ hidden: true })
  t.after(page.restore)
  const pets = createPets({ clock: () => NOW, rand: () => 0 })
  assert.equal(page.timers.length, 0, 'no clock while the page is hidden')
  pets.sync([session('codex__s1', 'idle')], {})
  const tile = pets.tile('row:codex__s1:done', 'codex__s1', 'done')
  assert.equal(pets.tile('row:codex__s1:done', 'codex__s1', 'done'), tile, 'kept, not made again')
  assert.equal(page.counts.canvases, 1, 'one canvas for the one tile')
  page.doc.hidden = false
  page.doc.fire('visibilitychange')
  assert.equal(page.running().length, 1, 'shown again: the clock starts')
  page.doc.hidden = true
  page.doc.fire('visibilitychange')
  assert.equal(page.running().length, 0, 'hidden: the clock stops')
})

test('pets: a tile off screen is not drawn until it scrolls into view', async (t) => {
  const { createPets } = await loadPets()
  const page = fakePage({ hidden: false, observer: true })
  t.after(page.restore)
  const pets = createPets({ clock: () => NOW, rand: () => 0 })
  pets.sync([session('codex__o1', 'working')], {})
  const tile = pets.tile('row:codex__o1', 'codex__o1', 'work')
  await flush()
  const [observer] = page.observers
  observer.callback([{ target: tile, isIntersecting: false }])
  const before = page.counts.fillRect
  page.tick(8)
  assert.equal(page.counts.fillRect, before, 'off screen: the pet paces but nothing is drawn')
  observer.callback([{ target: tile, isIntersecting: true }])
  assert.ok(page.counts.fillRect > before, 'in view: drawn at once, where the pet is now')
})
