import { createDemoState, demoAction, demoBrief, demoResume, demoSnapshot } from './state.mjs'

const STORAGE_KEY = 'agent-mods.demo.v1'
let state
try { state = JSON.parse(localStorage.getItem(STORAGE_KEY)) } catch {}
if (state?.snapshot?.v !== 1 || !Array.isArray(state.activity) || !state.briefs) state = createDemoState()
const streams = new Set()
const save = () => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch {} }
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

class DemoEvents extends EventTarget {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  readyState = DemoEvents.CONNECTING

  constructor() {
    super()
    streams.add(this)
    setTimeout(() => {
      if (this.readyState === DemoEvents.CLOSED) return
      this.readyState = DemoEvents.OPEN
      this.dispatchEvent(new Event('open'))
      this.send('snapshot', demoSnapshot(state))
      this.send('activity', state.activity)
    }, 0)
    this.timer = setInterval(() => this.send('snapshot', demoSnapshot(state)), 3000)
  }

  send(type, value) {
    if (this.readyState === DemoEvents.OPEN) this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(value) }))
  }

  close() {
    this.readyState = DemoEvents.CLOSED
    clearInterval(this.timer)
    streams.delete(this)
  }
}

const publish = () => {
  for (const stream of streams) {
    stream.send('snapshot', demoSnapshot(state))
    stream.send('activity', state.activity)
  }
}

// All application API calls are handled here. There is no dashboard server behind this demo.
window.EventSource = DemoEvents
window.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href)
  if (url.pathname === '/healthz') return reply({ app: 'agent-mods-demo', sample: true })
  if (url.pathname === '/api/snapshot') return reply(demoSnapshot(state))
  if (url.pathname === '/api/brief') {
    const result = demoBrief(state, url.searchParams.get('key'))
    return reply(result, result.status)
  }
  if (url.pathname === '/api/resume') {
    const result = demoResume(state, url.searchParams.get('key'), url.searchParams.get('shell'))
    return reply(result, result.status)
  }
  if (url.pathname === '/api/action' && options.method === 'POST') {
    let body
    try { body = JSON.parse(options.body) } catch { return reply({ ok: false, text: 'Enter a valid demo action.' }, 400) }
    const result = demoAction(state, body)
    if (result.ok) {
      save()
      setTimeout(publish, 0)
    }
    return reply(result, result.status)
  }
  return reply({ ok: false, text: 'This endpoint is unavailable in the browser demo.' }, 404)
}

document.getElementById('demo-reset').addEventListener('click', () => {
  state = createDemoState()
  save()
  location.reload()
})
await import('./app.js')
