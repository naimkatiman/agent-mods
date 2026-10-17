// prompt-enhancer's pure logic, ported from claude-mods/prompt-enhancer/hooks/register.tsx.
// No model call anywhere: the original forked the live Claude thread ($.model.fork) to answer the
// meta-prompt below; here the calling agent answers it itself, in its own context (enhance skill).
import { redact } from '../core/redact.mjs'
import { sha1 } from '../core/fsx.mjs'
import { AGENT_LABEL, agentLabel, sanitize } from '../core/text.mjs'

export const MARK = '<<<CHANGES>>>'
export const KEEP = 10 // taste records kept per project
export const CLIP = 300 // characters kept of each side of an edit example
export const OFFER_TTL_MS = 30 * 60_000
// Share of words a prompt must have in common with the rewrite to count as an edit of it.
export const SIMILAR = 0.5
const NOTES_MAX = 3
const NOTE_CHARS = 80

// How each agent invokes a skill by name; Claude Code, Grok and Devin Local use /skill-name.
const SKILL_SYNTAX = { codex: '$skill-name', cascade: '@skill-name' }

// register.tsx RULES, verbatim for Claude. Elsewhere "Claude Code" becomes the agent's label,
// "Claude" (the assistant) its name, and /skill-name that agent's skill syntax, so rewrites made in
// Codex, Grok or Devin do not cite Claude-only commands.
export function rulesFor(agent) {
  const known = Boolean(AGENT_LABEL[agent])
  const label = known ? agentLabel(agent) : 'a coding agent'
  const assistant = agent === 'claude' ? 'Claude' : known ? label : 'the agent'
  const skill = SKILL_SYNTAX[agent] ?? '/skill-name'
  return `You rewrite a developer's rough prompt for ${label} into a clear, specific one.
- Keep the author's intent; never invent requirements they did not imply.
- Name the concrete files, commands, skills (as ${skill}) or conventions from the project context that fit.
- State the goal, scope, constraints and what "done" looks like. Short is fine; no padding.
- Where something is genuinely ambiguous, add a line asking ${assistant} to confirm it rather than guessing.
Reply with the rewritten prompt (no preamble, no quotes, no code fence), then a line holding only ${MARK},
then 1-3 bullets of at most 8 words each saying what you added (files referenced, constraints, skill used).`
}

export function buildAsk(agent, taste, draft) {
  return `${rulesFor(agent)}${taste ? `\n\n${taste}` : ''}\n\n<rough_prompt>\n${draft}\n</rough_prompt>`
}

// Text pasted into a Windows terminal or read from a Windows file arrives with CRLF.
export function normText(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').trim()
}

// Splits the reply into the rewrite and its "what changed" bullets.
export function splitReply(raw) {
  const reply = String(raw ?? '').replace(/\r\n?/g, '\n')
  const at = reply.lastIndexOf(MARK)
  if (at < 0) return { text: reply.trim(), notes: [] }
  const notes = reply
    .slice(at + MARK.length)
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, NOTES_MAX)
    .map((l) => (l.length > NOTE_CHARS ? `${l.slice(0, NOTE_CHARS - 1)}…` : l))
  return { text: reply.slice(0, at).trim(), notes }
}

// Unlike core text.clip, keeps line breaks: an edit example should read as the prompt was written.
export function clip(s) {
  return s.length > CLIP ? `${s.slice(0, CLIP - 1)}…` : s
}

// Taste texts can come from another session or agent: strip control characters and keep them from
// closing the tags they sit in, so they stay examples, not instructions.
function example(text) {
  return sanitize(text ?? '').replace(/<(\/?)(rewrite|sent|user_taste|rough_prompt)>/gi, '‹$1$2›')
}

// Turns the history into guidance for the next rewrite; '' when there is none.
export function tasteHint(recs) {
  if (!recs.length) return ''
  const edits = recs.filter((r) => r.edited)
  const lines = [
    '<user_taste>',
    `Of your last ${recs.length} rewrites in this project, the user sent ${recs.length - edits.length} unchanged and edited ${edits.length}.`,
  ]
  if (edits.length) {
    const avg = Math.round(edits.reduce((n, r) => n + r.delta, 0) / edits.length)
    if (avg < -40) lines.push(`Their edits cut about ${-avg} characters on average: keep rewrites shorter.`)
    else if (avg > 40) lines.push(`Their edits add about ${avg} characters on average: be more thorough.`)
    lines.push('Recent edits (your rewrite, then what they sent); infer what they remove, keep or add:')
    for (const r of edits.slice(-3)) {
      lines.push(`<rewrite>${example(r.rewrite)}</rewrite>\n<sent>${example(r.sent)}</sent>`)
    }
  } else {
    lines.push('They like your rewrites as they are; keep the same style.')
  }
  lines.push('</user_taste>')
  return lines.join('\n')
}

// Token-like strings never reach the store: taste examples are shown to every agent in the project.
export { redact }

function wordSet(text) {
  return new Set(String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
}

// Shared words over the larger word set: a short reply ("send", "yes") never matches a long rewrite,
// while a rewrite trimmed to half its words, or grown to twice them, still does.
export function overlap(a, b) {
  const left = wordSet(a)
  const right = wordSet(b)
  const size = Math.max(left.size, right.size)
  if (!size) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared++
  return shared / size
}

// Whitespace-insensitive: a rewrite the agent re-sends, or a paste the terminal re-wrapped, is still
// the rewrite. Hashed so the stored offer needs no unredacted copy.
export function fingerprint(text) {
  return sha1(String(text ?? '').replace(/\s+/g, ' ').trim())
}

// The pending offer that replaces the original's `enhanced` atom. Texts are stored redacted; the
// fingerprint and length of the real rewrite are what sends are compared against.
export function makeOffer({ offerId, draft, reply, now, agent, projectId }) {
  const { text, notes } = splitReply(reply)
  if (!text) return null
  const offer = {
    offerId,
    draft: redact(normText(draft)),
    rewrite: redact(text),
    notes: notes.map(redact),
    createdAt: now,
    fingerprint: fingerprint(text),
    length: text.length,
    projectId,
    agent: agent ?? null,
  }
  return { offer, text, notes }
}

// recordSend's core (register.tsx:100-106): edited or not, the change in length, and both texts,
// clipped, only for an edit. `sent: null` records a send the caller says was unchanged.
export function recordFrom(offer, sentText, agent, now) {
  const sent = sentText === null ? null : normText(sentText)
  const edited = sent !== null && fingerprint(sent) !== offer.fingerprint
  const rec = { edited, delta: edited ? sent.length - offer.length : 0 }
  if (edited) {
    rec.rewrite = clip(offer.rewrite)
    rec.sent = clip(redact(sent))
  }
  rec.agent = offer.agent ?? agent ?? null
  rec.at = now
  return rec
}
