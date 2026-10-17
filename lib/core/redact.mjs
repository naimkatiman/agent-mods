// Best-effort removal of secrets from text that other agents will read: prompts and titles shown in
// peer briefings (possibly another vendor's model), enhance taste examples. One family per pattern.
const REDACTED = '[redacted]'

const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, // PEM keys
  /\b(?:sk-|(?:sk|rk)_(?:live|test)_)[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic, Stripe
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/g, // GitHub
  /\b(?:glpat|xai)-[A-Za-z0-9_-]{16,}/g, // GitLab, xAI
  /\b(?:npm|hf)_[A-Za-z0-9]{24,}/g, // npm, Hugging Face
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}/g, // Telegram bot token
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\b[0-9a-f]{32,}\b/gi, // long hex: hashes, hex secrets
]
const BEARER = /\b(Bearer)\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{16,}/gi
const BASIC_HEADER = /\b(Authorization:\s*Basic)\s+\S+/gi
const BASIC = /\b(Basic)\s+(?=[A-Za-z0-9+/]*[0-9+/])[A-Za-z0-9+/]{12,}={0,2}/g
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi
const CURL_USER = /(\s-u\s+[^\s:]+:)\S+/g
const ASSIGNED = /\b([A-Za-z0-9_]*(?:secret|token|password|passwd|api[_-]?key|private[_-]?key))(\s*[:=]\s*)(["']?)[^\s"']{6,}\3/gi
// DB_PASS, MYSQL_PWD, AWS_CREDENTIALS: the short words only as a whole name part, so bypass=... stays.
const ASSIGNED_PART = /\b((?:[A-Za-z0-9]+_)*(?:pass|pwd|credentials?))(\s*[:=]\s*)(["']?)[^\s"']{6,}\3/gi
const LONG_RUN = /[A-Za-z0-9+/_=-]{32,}/g

// A long base64-like run with digits and both cases is a key; a path or slug splits into short words.
function looksRandom(run) {
  if (!/\d/.test(run) || !/[a-z]/.test(run) || !/[A-Z]/.test(run)) return false
  return Math.max(...run.split(/[/_=+-]/).map((part) => part.length)) >= 16
}

export function redact(text) {
  let out = String(text ?? '')
  for (const re of SECRETS) out = out.replace(re, REDACTED)
  out = out
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(CURL_USER, `$1${REDACTED}`)
    .replace(BEARER, `$1 ${REDACTED}`)
    .replace(BASIC_HEADER, `$1 ${REDACTED}`)
    .replace(BASIC, `$1 ${REDACTED}`)
    .replace(ASSIGNED, `$1$2$3${REDACTED}$3`)
    .replace(ASSIGNED_PART, `$1$2$3${REDACTED}$3`)
  return out.replace(LONG_RUN, (run) => (looksRandom(run) ? REDACTED : run))
}
