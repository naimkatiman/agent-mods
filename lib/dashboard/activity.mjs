// The dashboard's activity feed: the clawd event log (events/YYYY-MM-DD.jsonl, one line per hook
// event, appended by the clawd mod) followed with clawd-watch's createFollower, each line cleaned
// for the page, and the last 30 minutes kept so a page that connects late starts with recent history.
//
// seed() is what the log held when the feed was created (cleaned, at most keepMs old, at most max
// lines); read(now) returns only the lines appended since the last read and adds them to the
// buffer; recent() is that buffer, for a page that has just connected. Reads the event log; owns
// no file.
//
// A clock stepped back across local midnight makes the follower switch back to the other day's file
// and read it again from its start (and again when midnight passes once more), which handed every
// page up to 400 old lines, then the same day's lines twice. So read() also drops a line older than
// keepMs, one older than the newest line already sent minus REPLAY_SLACK_MS, and one already sent
// inside that slack. The slack is there because hooks of several agents append slightly out of
// order and lines can share a millisecond. The cost: after a backward step longer than the slack,
// new lines are dropped until the clock passes the newest line sent (pets miss those events).
import { validHat } from '../mods/clawd-sprite.mjs'
import { createFollower } from '../mods/clawd-watch.mjs'
import { label, peerText } from '../mods/sessions-text.mjs'
import { PROJECT_ID, PROJECT_ID_MAX, SESSION_KEY, SESSION_KEY_MAX } from './snapshot.mjs'

export const KEEP_MS = 30 * 60_000
export const MAX_LINES = 400
const REPLAY_SLACK_MS = 2_000
const TEXT_MAX = 60
const EVENT = /^[a-z]+(?:\.[a-z]+)*$/
const EVENT_MAX = 40
const KIND = /^[a-z_]{1,20}$/

// A field that is absent reads as null; one that is present but malformed makes the line malformed.
function idOf(value, pattern, max) {
  if (value === null || value === undefined) return null
  return typeof value === 'string' && value.length <= max && pattern.test(value) ? value : undefined
}

// One event line as the page gets it: sid becomes key, pk becomes projectId, the agent's label is
// added, and every text field is sanitized and clipped. null for a line that is not an event.
// clawd.cmd lines also keep shades/hidden: the page's pets need them, as the terminal pane's do.
export function cleanLine(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null
  if (!Number.isFinite(e.t) || typeof e.ev !== 'string' || e.ev.length > EVENT_MAX || !EVENT.test(e.ev)) return null
  const key = idOf(e.sid, SESSION_KEY, SESSION_KEY_MAX)
  const projectId = idOf(e.pk, PROJECT_ID, PROJECT_ID_MAX)
  if (key === undefined || projectId === undefined) return null
  // Only an untargeted /clawd command has no session.
  if (key === null && e.ev !== 'clawd.cmd') return null
  const agent = typeof e.agent === 'string' && e.agent ? peerText(e.agent, 20) : null
  const line = { t: e.t, agent, agentLabel: agent ? label(agent) : null, key, projectId, project: typeof e.project === 'string' ? peerText(e.project, TEXT_MAX) : '', ev: e.ev }
  if (typeof e.kind === 'string' && KIND.test(e.kind)) line.kind = e.kind
  if (typeof e.label === 'string') line.label = peerText(e.label, TEXT_MAX)
  if (typeof e.ok === 'boolean') line.ok = e.ok
  if (validHat(e.hat)) line.hat = e.hat
  if (typeof e.verb === 'string') line.verb = peerText(e.verb, 20)
  if (typeof e.arg === 'string') line.arg = peerText(e.arg, TEXT_MAX)
  if (typeof e.shades === 'boolean') line.shades = e.shades
  if (typeof e.hidden === 'boolean') line.hidden = e.hidden
  return line
}

const cleanAll = (events) => events.map(cleanLine).filter(Boolean)

// A log that cannot be opened right now (another process, a scanner) is retried on the next read.
function follow(store, now) {
  try {
    return createFollower(store, now)
  } catch {
    return null
  }
}

export function createActivity(store, { now = Date.now(), keepMs = KEEP_MS, max = MAX_LINES } = {}) {
  const keep = (lines, at) => lines.filter((line) => at - line.t < keepMs).slice(-max)
  let follower = follow(store, now)
  const seeded = keep(cleanAll(follower?.seed() ?? []), now)
  let buffer = [...seeded]
  // What has been sent: the newest line's time, and every line sent within REPLAY_SLACK_MS of it.
  let newest = -Infinity
  const near = new Map()
  const sent = (lines) => {
    for (const line of lines) {
      newest = Math.max(newest, line.t)
      near.set(JSON.stringify(line), line.t)
    }
    for (const [text, t] of near) if (t < newest - REPLAY_SLACK_MS) near.delete(text)
  }
  const unsent = (lines, at) =>
    lines.filter((line) => at - line.t < keepMs && line.t >= newest - REPLAY_SLACK_MS && !near.has(JSON.stringify(line)))
  sent(seeded)
  return {
    seed: () => [...seeded],
    read(at = Date.now()) {
      let fresh = []
      try {
        if (follower) fresh = cleanAll(follower.read(at))
        else if ((follower = follow(store, at))) fresh = cleanAll(follower.seed())
      } catch {}
      fresh = unsent(fresh, at).slice(-max)
      sent(fresh)
      buffer = keep([...buffer, ...fresh], at)
      return fresh
    },
    recent: () => [...buffer],
  }
}
