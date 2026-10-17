// The design picker's browser end: one node:http server per open pick, on 127.0.0.1 and a random port.
// It replaces the original's python3 serve.py (claude-mods design-direction register.tsx:164-187) with
// the same contract, tightened: GET / serves the gallery and nothing else (serve.py served the whole
// pick folder), POST /answer/<token> takes exactly one answer and writes it atomically to answer.json
// in the store, where any process can wait on it. Every request must name this server in its Host
// header, so a page on another site that rebinds its domain to 127.0.0.1 is refused.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { writeJsonAtomic } from '../core/fsx.mjs'

export const MAX_BODY_BYTES = 64 * 1024
export const MAX_ANSWER_CHARS = 4000
const GRACE_MS = 2000

export function cspFor(nonce) {
  return [
    "default-src 'none'",
    'img-src data:',
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

function sameToken(given, token) {
  const a = Buffer.from(String(given))
  const b = Buffer.from(String(token))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// { answers: { <question>: string } } or { closed: true }; anything else is refused.
export function parseAnswer(text, questions) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  if (body.closed === true) return { closed: true }
  const answers = body.answers
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null
  const out = {}
  for (const [question, answer] of Object.entries(answers)) {
    if (!questions.includes(question) || typeof answer !== 'string' || answer.length > MAX_ANSWER_CHARS) return null
    out[question] = answer
  }
  return Object.values(out).some((a) => a.trim()) ? { answers: out } : null
}

// Resolves once listening: { url, port, close() }. onAnswer(answer) runs after answer.json is written
// and before the 204, onClose() once when the server stops (answered, lifetime over, or close()).
export function startPickServer({ html, nonce, token, answerFile, questions, onAnswer, onClose, lifetimeMs = 30 * 60_000 }) {
  const csp = cspFor(nonce)
  const timers = []
  let host = ''
  let answered = false
  let closed = false

  const server = http.createServer((req, res) => {
    // A client that drops mid-request emits 'error'; unhandled, it would take the host process down.
    req.on('error', () => {})
    const send = (status, headers = {}, body = '') => {
      if (res.headersSent) return
      res.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers })
      res.end(body)
    }
    try {
      if (req.headers.host !== host) return send(403)
      if (req.url === '/' && req.method === 'GET') {
        return send(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp, 'referrer-policy': 'no-referrer' }, html)
      }
      const match = /^\/answer\/([^/?#]+)$/.exec(req.url ?? '')
      if (!match || req.method !== 'POST') return send(404)
      if (!sameToken(match[1], token) || answered || fs.existsSync(answerFile)) return send(403)
      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) return send(413)
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size <= MAX_BODY_BYTES) chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          if (size > MAX_BODY_BYTES) return send(413)
          // A second tab or a double click can arrive while the first body was still streaming.
          if (answered || fs.existsSync(answerFile)) return send(403)
          const answer = parseAnswer(Buffer.concat(chunks).toString('utf8'), questions)
          if (!answer) return send(400)
          answered = true
          try {
            writeJsonAtomic(answerFile, { ...answer, at: Date.now() })
          } catch {
            // Nothing was saved, so the user can send again.
            answered = false
            return send(500)
          }
          // The answer is on disk whatever the callback does; it owns its own error reporting.
          try {
            onAnswer?.(answer)
          } catch {}
          send(204)
          // Stay up a moment so a second click gets a clear 403 instead of a refused connection.
          timers.push(setTimeout(close, GRACE_MS).unref())
        } catch {
          send(500)
        }
      })
    } catch {
      send(500)
    }
  })

  function close() {
    if (closed) return
    closed = true
    for (const timer of timers) clearTimeout(timer)
    // close() also drops idle keep-alive sockets; a reply still being written gets to finish.
    server.close()
    server.closeIdleConnections()
    try {
      onClose?.()
    } catch {}
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      server.on('error', () => {})
      const { port } = server.address()
      host = `127.0.0.1:${port}`
      // Never the reason a process stays alive: the MCP server lives on stdin, the CLI on its wait.
      server.unref()
      timers.push(setTimeout(close, lifetimeMs).unref())
      resolve({ url: `http://${host}/`, port, close })
    })
  })
}

// Opens the URL without a shell, so nothing in it is parsed as a command (the original ran macOS
// `open`, missing on Windows). Returns false when skipped (AGENT_MODS_NO_BROWSER=1, used by tests)
// or when the launcher could not start; callers always show the URL as well.
export function openBrowser(url, env = process.env) {
  if (env.AGENT_MODS_NO_BROWSER === '1') return false
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}
