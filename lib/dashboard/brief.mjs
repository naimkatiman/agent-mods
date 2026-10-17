// What the session detail reads when a row is opened: the first user prompt in full, how much of
// the context window that session has used, and a short prompt for continuing it.
//
// None of this is stored on the session record. The record keeps a 300-character last prompt, which
// is the wrong text and the wrong length. The first prompt and the token counts live in each
// agent's own transcript, read here on demand (one session, when its detail opens), never on the
// snapshot that goes out to every page. The first prompt is shown up to 100,000 characters,
// which covers the long opening prompts these sessions actually start with.
//
// A prompt is the first thing the user actually typed. Agent transcripts wrap that in system
// reminders, an AGENTS.md dump, or an environment block. Those are skipped. The text is the user's
// own, shown on their own machine, so it is not run through the peer redactor (that redactor turns
// long hex and code into "[redacted]" and would hide the prompt they asked to see). Control
// characters still come out.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clip, cut } from '../core/text.mjs'

export const PROMPT_MAX = 100_000
export const SUGGEST_MAX = 480
export const CONTINUE_BOX_MAX = 2000
const BIT = 100
const FILE_CAP = 48 * 1024 * 1024
const HEAD_BYTES = 1024 * 1024
const TAIL_BYTES = 1536 * 1024
const QUERY = /<user_query>([\s\S]*?)<\/user_query>/i

const codexHits = new Map()

function cleanPrompt(text) {
  // The same control and bidi characters sanitize() strips, without its length clip.
  // eslint-disable-next-line no-control-regex
  const cleaned = String(text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩]/g, '').trim()
  if (!cleaned) return { text: null, truncated: false }
  if (cleaned.length <= PROMPT_MAX) return { text: cleaned, truncated: false }
  return { text: cut(cleaned, PROMPT_MAX), truncated: true }
}

// One user block, or null when the block is harness text rather than something the user typed.
export function promptFromText(text) {
  const raw = String(text ?? '')
  const tagged = QUERY.exec(raw)
  if (tagged && tagged[1].trim()) return tagged[1].trim()
  const stripped = raw
    .replace(/<user_info>[\s\S]*?<\/user_info>/gi, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<available_skills>[\s\S]*?<\/available_skills>/gi, '')
    .replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/gi, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, '')
    .replace(/<image\b[^>]*\/?>/gi, '')
    .trim()
  if (!stripped || stripped.length < 2) return null
  if (/^# AGENTS\.md\b/.test(stripped) && stripped.length > 2000) return null
  if (/^You are /.test(stripped) && stripped.length > 2000) return null
  return stripped
}

function promptsIn(content) {
  const parts = Array.isArray(content) ? content : [content]
  const out = []
  for (const part of parts) {
    const text = typeof part === 'string' ? part : part?.text ?? part?.content
    if (typeof text !== 'string' || !text) continue
    const prompt = promptFromText(text)
    if (prompt) out.push(prompt)
  }
  return out
}

function promptOf(content) {
  return promptsIn(content)[0] ?? null
}

// A continuation the user can edit. Built from the record's own done / doing / next / answer.
// No model call: the dashboard does not have one, and the suggestion has to be ready as the row opens.
export function suggestNext(session = {}) {
  const lines = ['Continue this session from where it stopped.']
  if (session.done) lines.push(`Already done: ${clip(session.done, BIT)}`)
  if (session.doing) lines.push(`You were doing: ${clip(session.doing, BIT)}`)
  if (session.next) lines.push(`Do this next: ${clip(session.next, BIT)}`)
  else if (session.answer) lines.push(`Last result: ${clip(session.answer, BIT)}`)
  lines.push('Finish the original request. Do not start over.')
  const text = lines.join('\n')
  return text.length > SUGGEST_MAX ? clip(text, SUGGEST_MAX) : text
}

// What "Auto compact, then send" queues. The compact line is added here, not typed by the user,
// so the box stays the prompt they wrote.
export function continuePrompt(prompt) {
  return [
    'Compact this session first. Summarize what is done and what is still open, and drop tool output and earlier turns.',
    'Then do this prompt:',
    String(prompt ?? '').trim(),
  ].join('\n\n')
}

export function contextLabel(context) {
  if (!context || !Number.isFinite(context.used)) return 'Context used: not recorded for this session.'
  const used = Math.round(context.used).toLocaleString('en-US')
  const compact = context.compactions > 0 ? ` Compacted ${context.compactions === 1 ? 'once' : `${context.compactions} times`}.` : ''
  if (Number.isFinite(context.window) && context.window > 0) {
    const window = Math.round(context.window).toLocaleString('en-US')
    const percent = Number.isFinite(context.percent) ? context.percent : Math.round((context.used / context.window) * 100)
    return `Context used: ${used} / ${window} (${percent}%).${compact}`
  }
  return `Context used: ${used} tokens on the last turn.${compact}`
}

function contextOf(used, window, compactions = 0) {
  const n = Number(used)
  if (!Number.isFinite(n) || n < 0) return null
  const size = Number(window)
  const compactN = Number(compactions)
  const out = {
    used: Math.round(n),
    window: Number.isFinite(size) && size > 0 ? Math.round(size) : null,
    percent: null,
    compactions: Number.isFinite(compactN) && compactN > 0 ? Math.round(compactN) : 0,
  }
  if (out.window) out.percent = Math.round((out.used / out.window) * 100)
  return out
}

function homesOf(session) {
  if (typeof session?.home === 'string' && session.home) return [session.home]
  const root = os.homedir()
  if (session?.agent === 'grok') return [path.join(root, '.grok')]
  if (session?.agent === 'claude') return [path.join(root, '.claude')]
  if (session?.agent === 'codex') return [path.join(root, '.codex')]
  if (session?.agent === 'devin') return [path.join(process.env.APPDATA || path.join(root, 'AppData', 'Roaming'), 'devin')]
  return []
}

function exists(file) {
  try {
    return fs.existsSync(file)
  } catch {
    return false
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// The first user message is at the start and the latest token count is at the end. A long transcript
// is not read whole: the head and the tail are enough, and a file past FILE_CAP is left alone.
function readBounded(file) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return ''
  }
  if (!stat.isFile() || stat.size > FILE_CAP || stat.size === 0) return ''
  const fd = fs.openSync(file, 'r')
  try {
    if (stat.size <= HEAD_BYTES + TAIL_BYTES) {
      const buf = Buffer.alloc(stat.size)
      fs.readSync(fd, buf, 0, stat.size, 0)
      return buf.toString('utf8')
    }
    const head = Buffer.alloc(HEAD_BYTES)
    fs.readSync(fd, head, 0, HEAD_BYTES, 0)
    const tail = Buffer.alloc(TAIL_BYTES)
    fs.readSync(fd, tail, 0, TAIL_BYTES, stat.size - TAIL_BYTES)
    return `${head.toString('utf8')}\n${tail.toString('utf8')}`
  } finally {
    fs.closeSync(fd)
  }
}

function eachLine(file, fn) {
  const text = readBounded(file)
  if (!text) return
  for (const line of text.split(/\n/)) {
    if (!line.trim()) continue
    let obj = null
    try {
      obj = JSON.parse(line)
    } catch {
      obj = null
    }
    fn(obj, line)
  }
}

// Claude's project folder: D:\Sample Telegram Projects\SampleApp -> d--Sample-Telegram-Projects-SampleApp
export function claudeProjectSlug(cwd) {
  const slugged = String(cwd ?? '').replace(/\\/g, '/').replace(/[:/]/g, '-').replace(/\s+/g, '-')
  return slugged.replace(/^[A-Za-z]/, (ch) => ch.toLowerCase())
}

function claudeUsage(message) {
  const usage = message?.usage
  if (!usage || typeof usage !== 'object') return null
  const parts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens]
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0)
  if (!parts.length) return null
  return parts.reduce((sum, n) => sum + n, 0)
}

function scanClaude(file) {
  const state = { prompt: null, used: null }
  eachLine(file, (obj, line) => {
    if (!obj) {
      if (!state.prompt) state.prompt = promptFromText(line)
      return
    }
    if (!state.prompt && obj.type === 'user' && obj.isSidechain !== true) {
      state.prompt = promptOf(obj.message?.content ?? obj.message ?? obj.content)
    }
    if (obj.type === 'assistant') {
      const used = claudeUsage(obj.message)
      if (used !== null) state.used = used
    }
  })
  return state
}

function scanCodex(file) {
  const state = { prompt: null, used: null, window: null }
  eachLine(file, (obj) => {
    if (!obj || typeof obj !== 'object') return
    const payload = obj.payload
    if (!payload || typeof payload !== 'object') return
    if (!state.prompt && obj.type === 'response_item' && payload.role === 'user') state.prompt = promptOf(payload.content)
    if (obj.type === 'event_msg' && payload.type === 'token_count') {
      const used = Number(payload.info?.last_token_usage?.input_tokens)
      const window = Number(payload.info?.model_context_window)
      if (Number.isFinite(used) && used >= 0) state.used = used
      if (Number.isFinite(window) && window > 0) state.window = window
    }
  })
  return state
}

function scanGrok(file) {
  let prompt = null
  eachLine(file, (obj, line) => {
    if (prompt) return
    if (obj?.type === 'user') prompt = promptOf(obj.content)
    else if (!obj) prompt = promptFromText(line)
  })
  return prompt
}

function grokNames(cwd) {
  const raw = String(cwd ?? '')
  return [...new Set([raw, raw.replace(/\//g, '\\'), raw.replace(/\\/g, '/')])].filter(Boolean).map(encodeURIComponent)
}

function findGrokDir(session) {
  const id = String(session.id ?? '')
  if (!id) return null
  for (const home of homesOf(session)) {
    const root = path.join(home, 'sessions')
    for (const name of grokNames(session.cwd)) {
      const dir = path.join(root, name, id)
      if (exists(path.join(dir, 'signals.json')) || exists(path.join(dir, 'chat_history.jsonl'))) return dir
    }
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(root, entry.name, id)
      if (exists(path.join(dir, 'signals.json')) || exists(path.join(dir, 'chat_history.jsonl'))) return dir
    }
  }
  return null
}

function findClaudeFile(session) {
  const id = String(session.id ?? '')
  if (!id) return null
  const slugs = [...new Set([claudeProjectSlug(session.cwd), claudeProjectSlug(session.cwd).toLowerCase()])]
  for (const home of homesOf(session)) {
    for (const slug of slugs) {
      const file = path.join(home, 'projects', slug, `${id}.jsonl`)
      if (exists(file)) return file
    }
  }
  return null
}

function findCodexFile(session) {
  const id = String(session.id ?? '')
  if (!id) return null
  const cached = codexHits.get(id)
  if (cached && exists(cached)) return cached
  const suffix = `-${id}.jsonl`
  for (const home of homesOf(session)) {
    for (const folder of ['sessions', 'archived_sessions']) {
      const found = walkFor(path.join(home, folder), suffix, 0)
      if (found) {
        codexHits.set(id, found)
        return found
      }
    }
  }
  return null
}

function walkFor(dir, suffix, depth) {
  if (depth > 5) return null
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = walkFor(full, suffix, depth + 1)
      if (found) return found
    } else if (entry.name.endsWith(suffix)) return full
  }
  return null
}

function fallbackPrompt(session) {
  return typeof session?.lastPrompt === 'string' && session.lastPrompt.trim() ? session.lastPrompt.trim() : null
}

function pack(prompt, context) {
  const cleaned = cleanPrompt(prompt)
  return { firstPrompt: cleaned.text, truncated: cleaned.truncated, context }
}

function readGrok(session) {
  const dir = findGrokDir(session)
  if (!dir) return pack(fallbackPrompt(session), null)
  const signals = readJson(path.join(dir, 'signals.json'))
  const context = contextOf(signals?.contextTokensUsed, signals?.contextWindowTokens, signals?.compactionCount)
  const prompt = scanGrok(path.join(dir, 'chat_history.jsonl'))
  return pack(prompt ?? fallbackPrompt(session), context)
}

function readClaude(session) {
  const file = findClaudeFile(session)
  if (!file) return pack(fallbackPrompt(session), null)
  const state = scanClaude(file)
  return pack(state.prompt ?? fallbackPrompt(session), contextOf(state.used, null, 0))
}

function readCodex(session) {
  const file = findCodexFile(session)
  if (!file) return pack(fallbackPrompt(session), null)
  const state = scanCodex(file)
  return pack(state.prompt ?? fallbackPrompt(session), contextOf(state.used, state.window, 0))
}

export function readBrief(session) {
  const suggestion = suggestNext({
    done: session?.done,
    doing: session?.doing,
    next: session?.next,
    answer: session?.answer ?? session?.lastAnswer,
  })
  let body = { firstPrompt: null, truncated: false, context: null }
  try {
    if (session?.agent === 'grok') body = readGrok(session)
    else if (session?.agent === 'claude' || session?.agent === 'devin') body = readClaude(session)
    else if (session?.agent === 'codex') body = readCodex(session)
    else body = pack(fallbackPrompt(session), null)
  } catch {
    body = pack(fallbackPrompt(session), null)
  }
  return { ...body, suggestion }
}
