// Text helpers shared by the mods. clip/tail/ago keep the originals' semantics
// (session-tracker register.tsx:14-29).

// The first `max` UTF-16 units, without splitting a surrogate pair: half an emoji becomes a lone
// \ud83d escape in JSON, which the serde_json parsers of Codex, Devin and Grok reject.
export function cut(text, max) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  const end = Math.max(0, max)
  return s.slice(0, end > 0 && /[\uD800-\uDBFF]/.test(s[end - 1]) ? end - 1 : end)
}

export function clip(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${cut(flat, Math.max(0, max - 1))}…` : flat
}

// Last blank-line-separated paragraph, clipped (session-tracker tail()).
export function tail(answer, max = 300) {
  const parts = String(answer ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  return clip(parts.length ? parts[parts.length - 1] : '', max)
}

export function ago(ms, now = Date.now()) {
  const sec = Math.max(0, Math.round((now - ms) / 1000))
  if (sec < 60) return 'now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  const hours = Math.round(min / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

export function agoText(ms, now = Date.now()) {
  const value = ago(ms, now)
  return value === 'now' ? 'just now' : `${value} ago`
}

export function plural(n, word, pluralWord = `${word}s`) {
  return `${n} ${n === 1 ? word : pluralWord}`
}

// Text written by another agent session ends up in this agent's context. Strip control
// characters (C0, C1, and the bidi overrides that reorder what a reader sees) and cap it, so it
// reads as data, not as a wall of instructions.
export function sanitize(text, max = 500) {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩]/g, '')
  return cleaned.length > max ? `${cut(cleaned, max - 1)}…` : cleaned
}

// JSON.stringify replacer for anything an agent parses: no lone surrogates (see cut()).
export function wellFormed(_key, value) {
  return typeof value === 'string' ? value.toWellFormed() : value
}

export const AGENT_LABEL = {
  claude: 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
  devin: 'Devin',
  cascade: 'Devin Cascade',
}

export function agentLabel(agent) {
  return AGENT_LABEL[agent] ?? agent
}
