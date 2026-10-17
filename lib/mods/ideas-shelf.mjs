// The idea shelf store and its pure logic, ported from claude-mods idea-shelf (hooks/register.tsx).
//
// One shelf per repository: projects/<projectId>/ideas.json = { v: 1, ideas: [...] }, shared by every
// worktree, every agent session and the CLI. The original held the list in memory and wrote all of it
// back on every change (register.tsx:40-44), so two sessions on one folder silently dropped each
// other's adds. Here every change is one add, take, restore or remove by id under the file's lock,
// and every read goes back to the file.
import { AGENTS } from '../core/agents.mjs'
import { projectFile, touchProjectMeta } from '../core/store.mjs'
import { agentLabel, agoText, sanitize } from '../core/text.mjs'

export const MAX_TEXT = 300
// Keeps ideas.json small: hooks read it at every SessionStart and Stop.
export const MAX_IDEAS = 300
const MAX_FILES = 20
// A take that no session completed goes back on the shelf after this long. The original removed ideas
// before their queued prompt ran (register.tsx:56-62), so quitting in between lost them.
export const TAKE_TTL_MS = 2 * 3_600_000
const EMPTY = { v: 1, ideas: [] }
const SOURCES = new Set(['you', 'agent', ...AGENTS])

// Common words that would match almost anything; left out of relevance matching.
export const STOP = new Set(('this that with from into have will would could should about after before then than them they ' +
  'there their what when where which while also just like make more most some such only very each other these those ' +
  'file files code idea ideas maybe later todo want need using used use add adds added fix fixes update changes change').split(' '))

// Lowercased keywords of a text: camelCase, snake_case and paths split apart.
export function words(text) {
  return String(text ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((w) => w.replace(/s$/, ''))
    .filter((w) => w.length >= 4 && !STOP.has(w))
}

// Words naming a file: its base name and its folder (not the whole absolute path). Splits on both
// separators: the original split on '/' only, so a Windows path was tokenized whole and every edit
// under 'D:\Sample Telegram Projects\' matched any idea that mentions telegram.
export function pathWords(file) {
  return words(String(file ?? '').split(/[\\/]/).slice(-2).join(' '))
}

// What an idea is about: its text, plus the files it names (a field the port adds).
export function ideaWords(idea) {
  return [...words(idea.text), ...(idea.files ?? []).flatMap((file) => pathWords(file))]
}

// Near-duplicates share a word set ('cache the parser output' = 'Cache parser outputs'). Texts with
// no keywords at all compare as plain lowercased text instead.
export function wordKey(text) {
  const set = [...new Set(words(text))].sort()
  return set.length ? set.join(' ') : String(text).toLowerCase().replace(/\s+/g, ' ').trim()
}

// The prompt that hands ideas to an agent (the original send(), register.tsx:58-60).
export function promptFor(picked) {
  return picked.length === 1
    ? picked[0].text
    : `Shelved ideas to pick up:\n${picked.map((idea) => `- ${idea.text}`).join('\n')}`
}

// One line, no control characters: idea text ends up in other agents' prompts and in terminals.
export function cleanText(text) {
  return sanitize(String(text ?? ''), Infinity)
    .replace(/[\u0080-\u009F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// null when the text can be shelved, else 'empty' or 'long'.
export function textProblem(text) {
  if (!text) return 'empty'
  if (text.length > MAX_TEXT) return 'long'
  return null
}

export function cleanFiles(files) {
  if (!Array.isArray(files)) return undefined
  const out = [...new Set(files.map((f) => (typeof f === 'string' ? cleanText(f).slice(0, MAX_TEXT) : '')).filter(Boolean))]
  return out.length ? out.slice(0, MAX_FILES) : undefined
}

// Unknown agents keep their own label out of the shelf instead of passing for the user.
export function sourceFor(agent) {
  return AGENTS.includes(agent) ? agent : 'agent'
}

// `${ms}-${4 base-36 chars}` as in the original (register.tsx:47), redrawn on the rare collision.
function newId(now, ideas) {
  const used = new Set(ideas.map((idea) => idea.id))
  for (;;) {
    const id = `${now}-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`
    if (!used.has(id)) return id
  }
}

function normalizeIdea(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null
  const text = cleanText(raw.text).slice(0, MAX_TEXT)
  if (!text) return null
  const idea = {
    id: raw.id,
    text,
    // A missing source reads as the user's, as the original's legacy rule (types/index.d.ts:1).
    source: raw.source === undefined || raw.source === null ? 'you' : SOURCES.has(raw.source) ? raw.source : 'agent',
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Number.parseInt(raw.id, 10) || 0,
    status: raw.status === 'taken' ? 'taken' : 'open',
  }
  const files = cleanFiles(raw.files)
  if (files) idea.files = files
  if (idea.status === 'taken') {
    const by = raw.takenBy && typeof raw.takenBy === 'object' ? raw.takenBy : {}
    idea.takenBy = {
      agent: typeof by.agent === 'string' ? by.agent : null,
      sessionKey: typeof by.sessionKey === 'string' ? by.sessionKey : null,
      at: Number(by.at) || 0,
    }
  }
  return idea
}

export function normalizeShelf(raw) {
  const list = Array.isArray(raw?.ideas) ? raw.ideas : []
  return { v: 1, ideas: list.map(normalizeIdea).filter(Boolean) }
}

export function shelfRel(project) {
  return projectFile(project, 'ideas.json')
}

export function readShelf(store, project) {
  return normalizeShelf(store.readJson(shelfRel(project), null))
}

// Expired takes read as open: no hidden write on a read path.
export function isTaken(idea, now) {
  return idea.status === 'taken' && now - (idea.takenBy?.at ?? 0) < TAKE_TTL_MS
}

// A live claim by this session (a CLI take has no session, so nobody holds it).
export function heldBy(idea, sessionKey, now) {
  return isTaken(idea, now) && Boolean(sessionKey) && idea.takenBy?.sessionKey === sessionKey
}

// Display order: open ideas first (shelf order), then taken ones. An open idea keeps its number
// whether or not taken ideas are shown.
export function ordered(shelf, now, includeTaken = false) {
  const open = shelf.ideas.filter((idea) => !isTaken(idea, now))
  return includeTaken ? [...open, ...shelf.ideas.filter((idea) => isTaken(idea, now))] : open
}

// Refs are idea ids or 1-based numbers ('2', 2, '#2') into the list the caller last saw, else into
// the current display order. Ids always contain '-', so a bare number is never an id.
export function toRefs(ids) {
  const list = Array.isArray(ids) ? ids : ids === undefined || ids === null ? [] : [ids]
  return list.flatMap((item) => String(item).split(/[\s,]+/)).map((ref) => ref.trim().replace(/^#/, '')).filter(Boolean)
}

export function resolveRefs(refs, shelf, now, lastList) {
  const order = Array.isArray(lastList) && lastList.length ? lastList : ordered(shelf, now, true).map((idea) => idea.id)
  return refs.map((ref) => (/^\d+$/.test(ref) ? { ref, id: order[Number(ref) - 1] ?? null } : { ref, id: ref }))
}

export function sourceLabel(source) {
  return source === 'you' ? 'you' : agentLabel(source)
}

export function takerLabel(takenBy) {
  return sourceLabel(takenBy?.agent ?? 'agent')
}

export function ideaLine(n, idea, now) {
  const files = idea.files?.length ? ` [${idea.files.join(', ')}]` : ''
  const taken = isTaken(idea, now) ? `; taken by ${takerLabel(idea.takenBy)} ${agoText(idea.takenBy.at, now)}` : ''
  return `${n}. ${idea.text}${files}  (${sourceLabel(idea.source)}, ${agoText(idea.createdAt, now)}${taken})`
}

// The shape tools and --json return.
export function publicIdea(idea, now, n) {
  const out = { id: idea.id, text: idea.text, source: idea.source, createdAt: idea.createdAt, status: isTaken(idea, now) ? 'taken' : 'open' }
  if (n) out.n = n
  if (idea.files) out.files = idea.files
  if (out.status === 'taken') out.takenBy = idea.takenBy
  return out
}

// One locked read-modify-write of the shelf. fn(shelf) returns { next?: ideas, result }.
function mutate(store, project, fn) {
  let result
  store.update(shelfRel(project), EMPTY, (raw) => {
    const step = fn(normalizeShelf(raw))
    result = step.result
    return step.next ? { v: 1, ideas: step.next } : undefined
  })
  return result
}

export function addIdea(store, project, { text, files, source, now }) {
  const key = wordKey(text)
  const result = mutate(store, project, (shelf) => {
    const open = ordered(shelf, now)
    const same = open.find((idea) => wordKey(idea.text) === key)
    if (same) return { result: { idea: same, duplicate: true, count: open.length } }
    if (shelf.ideas.length >= MAX_IDEAS) return { result: { full: true, count: open.length } }
    const idea = { id: newId(now, shelf.ideas), text, source, createdAt: now, status: 'open' }
    if (files) idea.files = files
    return { next: [...shelf.ideas, idea], result: { idea, duplicate: false, count: open.length + 1 } }
  })
  if (result.idea && !result.duplicate) {
    // meta.json only names the project for `idea list --all-projects`; never fail an add over it.
    try {
      touchProjectMeta(store, project, now)
    } catch {}
  }
  return result
}

// Claims open ideas for one caller. Two callers racing for one idea serialize on the lock, and the
// second sees it taken. A session may re-take what it already holds.
export function takeIdeas(store, project, refs, { agent, sessionKey, now, lastList }) {
  return mutate(store, project, (shelf) => {
    const byId = new Map(shelf.ideas.map((idea) => [idea.id, idea]))
    const picked = []
    const missing = []
    for (const { ref, id } of resolveRefs(refs, shelf, now, lastList)) {
      const idea = id ? byId.get(id) : undefined
      if (!idea) missing.push({ ref, reason: 'not on the shelf' })
      else if (isTaken(idea, now) && !heldBy(idea, sessionKey, now)) {
        missing.push({ ref, reason: `taken by ${takerLabel(idea.takenBy)} ${agoText(idea.takenBy.at, now)}` })
      } else if (!picked.includes(idea.id)) picked.push(idea.id)
    }
    if (!picked.length) return { result: { taken: [], missing } }
    const takenBy = { agent, sessionKey, at: now }
    const next = shelf.ideas.map((idea) => (picked.includes(idea.id) ? { ...idea, status: 'taken', takenBy } : idea))
    const nextById = new Map(next.map((idea) => [idea.id, idea]))
    return { next, result: { taken: picked.map((id) => nextById.get(id)), missing } }
  })
}

export function restoreIdeas(store, project, refs, { now, lastList }) {
  return mutate(store, project, (shelf) => {
    const ids = new Set()
    const missing = []
    for (const { ref, id } of resolveRefs(refs, shelf, now, lastList)) {
      const idea = shelf.ideas.find((one) => one.id === id)
      if (idea?.status === 'taken') ids.add(id)
      else missing.push({ ref, reason: idea ? 'not taken' : 'not on the shelf' })
    }
    if (!ids.size) return { result: { restored: [], missing } }
    const next = shelf.ideas.map((idea) => {
      if (!ids.has(idea.id)) return idea
      const { takenBy, ...rest } = idea
      return { ...rest, status: 'open' }
    })
    return { next, result: { restored: next.filter((idea) => ids.has(idea.id)), missing } }
  })
}

export function removeIdeas(store, project, refs, { now, lastList }) {
  return mutate(store, project, (shelf) => {
    const ids = new Set()
    const missing = []
    for (const { ref, id } of resolveRefs(refs, shelf, now, lastList)) {
      if (id && shelf.ideas.some((idea) => idea.id === id)) ids.add(id)
      else missing.push({ ref, reason: 'not on the shelf' })
    }
    if (!ids.size) return { result: { removed: [], missing } }
    return {
      next: shelf.ideas.filter((idea) => !ids.has(idea.id)),
      result: { removed: shelf.ideas.filter((idea) => ids.has(idea.id)), missing },
    }
  })
}

// A finished turn of the session that took ideas means their prompt ran: they leave the shelf, as the
// original's Send removed them. An expired take is not completed: it already reads as open again, and
// a resumed session's next Stop must not delete what the user sees back on the shelf.
export function completeTakes(store, project, sessionKey, now) {
  return mutate(store, project, (shelf) => {
    const done = shelf.ideas.filter((idea) => heldBy(idea, sessionKey, now))
    if (!done.length) return { result: [] }
    return { next: shelf.ideas.filter((idea) => !done.includes(idea)), result: done }
  })
}

export function missingText(missing) {
  return missing.map((m) => `${m.ref} (${m.reason})`).join(', ')
}
