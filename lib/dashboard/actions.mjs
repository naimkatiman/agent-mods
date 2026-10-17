// The dashboard's write side: one POST /api/action body in, checked field by field (the browser is
// never trusted), then handed to the function the CLI or the MCP tool uses for the same change, so a
// click on the page and a command in a terminal leave the store in the same state.
//
// Returns { status, ok, text, data? }: 200 done; 400 a bad body (not an object, an unknown type, an
// unknown or malformed field); 404 the project, idea, assumption, rule or session does not exist;
// 409 the change does not fit the current state (the project's folder is gone, the session ended,
// the idea is not taken, the shelf is full); 503 a store lock stayed busy; 500 anything else, logged.
//
// Writes only through those functions: sessions/<key>/inbox/ (send), projects/<id>/ideas.json,
// projects/<id>/assumptions.json, config.json (notify), plain.json, clawd.json,
// sessions/<key>/clawd.json and events/ (clawd). Owns no file.
import { projectInfo } from '../core/project.mjs'
import { readRecord } from '../core/session-records.mjs'
import { loadConfig, logError, projectFile, sessionKey, setConfigValue } from '../core/store.mjs'
import { plural, sanitize } from '../core/text.mjs'
import { deleteRule, judgeItem, verdictReport } from '../mods/assumptions.mjs'
import { MAX_TEXT as FIX_MAX, cleanText as cleanCorrection } from '../mods/assumptions-logic.mjs'
import { runCommand } from '../mods/clawd.mjs'
import { WEARABLE, validHat } from '../mods/clawd-sprite.mjs'
import { MAX_IDEAS, MAX_TEXT as IDEA_MAX, addIdea, cleanText as cleanIdea, promptFor, readShelf, removeIdeas, restoreIdeas, textProblem } from '../mods/ideas-shelf.mjs'
import { notifySettings, runPlainCommand } from '../mods/plain.mjs'
import { LEVELS } from '../mods/plain-rules.mjs'
import { sendMessage, sendResultData, sendResultText } from '../mods/sessions-data.mjs'
import { peerText, projectOf } from '../mods/sessions-text.mjs'
import { CONTINUE_BOX_MAX, continuePrompt } from './brief.mjs'
import { PROJECT_ID, PROJECT_ID_MAX, SESSION_KEY, SESSION_KEY_MAX, projectFolder } from './snapshot.mjs'

// The page sends as itself; the recipient reads "the agent-mods dashboard" (sessions-text frameMessage).
const FROM = { agent: 'dashboard', id: null, title: null }
const CLAWD_VERBS = ['pet', 'dance', 'party', 'shades', 'hide', 'show', 'hat']
// Idea ids are `${ms}-${4 base-36 chars}`; a bare number would be read as a list position.
const IDEA_ID = /^\d{1,16}-[a-z0-9]{1,12}$/
// Generous caps on raw text: the real limits (500 for a message, 300 for an idea) are applied by
// the functions below, with their own wording.
const TEXT_RAW_MAX = 4000
const ARG_MAX = 40
const REPLY_MAX = 4000
const SEND_STATUS = { queued: 200, empty: 400, 'too-long': 400, 'not-found': 404, ambiguous: 409, ended: 409 }
const FOLDER_GONE = "This project's folder is gone."
const NO_IDEA = 'That idea is not on the shelf.'
const NO_SESSION = 'No session with that key.'

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const done = (text, data) => ({ status: 200, ok: true, text: sanitize(text, REPLY_MAX), data })
const fail = (status, text) => ({ status, ok: false, text: sanitize(text, REPLY_MAX) })

// --- field checks: each returns { value } or { error } --------------------------------------------

const required = (check) => (value, name) => (value === undefined || value === null ? { error: `${name} is required.` } : check(value, name))
const optional = (check) => (value, name) => (value === undefined || value === null ? { value: null } : check(value, name))

const stringUpTo = (max) => (value, name) =>
  typeof value === 'string' && value.length <= max ? { value } : { error: `${name} must be text of at most ${max} characters.` }

const oneOf = (list) => (value, name) => (list.includes(value) ? { value } : { error: `${name} must be one of: ${list.join(', ')}.` })

const matching = (pattern, max, what) => (value, name) =>
  typeof value === 'string' && value.length <= max && pattern.test(value) ? { value } : { error: `${name} must be ${what}.` }

const sessionKeyField = matching(SESSION_KEY, SESSION_KEY_MAX, 'a session key (agent__id)')
const projectIdField = matching(PROJECT_ID, PROJECT_ID_MAX, 'a project id')
const ideaIdField = matching(IDEA_ID, 40, 'an idea id (never a list number)')

function wholeNumber(value, name) {
  return Number.isSafeInteger(value) && value > 0 ? { value } : { error: `${name} must be a whole number above 0.` }
}

function boolean(value, name) {
  return typeof value === 'boolean' ? { value } : { error: `${name} must be true or false.` }
}

// --- projects -------------------------------------------------------------------------------------

// projects/<id>/meta.json must exist: an update against any other id would create its folder.
function projectRef(store, projectId) {
  if (!store.exists(projectFile({ projectId }, 'meta.json'))) return null
  let meta = null
  try {
    meta = store.readJson(projectFile({ projectId }, 'meta.json'), null)
  } catch {}
  return { projectId, name: typeof meta?.name === 'string' && meta.name ? meta.name : projectId, meta }
}

const noProject = (projectId) => fail(404, `No project ${projectId}.`)

// --- actions --------------------------------------------------------------------------------------

// An exact key: sendMessage would otherwise fall back to id prefixes and titles. Its only candidate is
// the record that key names, taken the way listRecords takes one (an agent and an id, and the key
// they make when the file has none), so a send opens one file instead of every record in the store
// (580 records: 101-546 ms on the server's event loop, measured 2026-10-12).
function send(store, { key, text }, { now }) {
  const record = readRecord(store, key)
  if (!record) return fail(404, NO_SESSION)
  const candidates = record.agent && record.id ? [{ ...record, key: record.key ?? sessionKey(record.agent, record.id) }] : []
  const result = sendMessage(store, { to: key, text, from: FROM, now, candidates })
  const status = SEND_STATUS[result.status] ?? 500
  return status === 200 ? done(sendResultText(result), sendResultData(result)) : fail(status, sendResultText(result))
}

// The box text plus a compact instruction. It rides the same inbox as a peer message, so it arrives
// on the session's next turn. It does not press /compact inside the live terminal.
function continueSend(store, { key, text }, { now }) {
  const prompt = String(text ?? '').trim()
  if (!prompt) return fail(400, 'Write the prompt in the box first.')
  if (prompt.length > CONTINUE_BOX_MAX) return fail(400, `The prompt is ${prompt.length} characters; the box takes ${CONTINUE_BOX_MAX}.`)
  const record = readRecord(store, key)
  if (!record) return fail(404, NO_SESSION)
  const candidates = record.agent && record.id ? [{ ...record, key: record.key ?? sessionKey(record.agent, record.id) }] : []
  const result = sendMessage(store, { to: key, text: continuePrompt(prompt), from: FROM, now, candidates, max: 4000, kind: 'continue' })
  const status = SEND_STATUS[result.status] ?? 500
  if (status !== 200) return fail(status, sendResultText(result))
  return done(sendResultText(result).replace('It is shown to that session', 'It is told to compact, then to do the prompt from the box, and that is shown to that session'), sendResultData(result))
}

function ideaAdd(store, { projectId, text }, { now }) {
  const clean = cleanIdea(text)
  const problem = textProblem(clean)
  if (problem === 'empty') return fail(400, 'The idea is empty.')
  if (problem === 'long') return fail(400, `An idea is one line of at most ${IDEA_MAX} characters.`)
  const project = projectRef(store, projectId)
  if (!project) return noProject(projectId)
  // addIdea records the folder in meta.json, so it needs the real project, not just its id.
  const folder = projectFolder(project.meta, projectId)
  if (!folder) return fail(409, FOLDER_GONE)
  const result = addIdea(store, projectInfo(folder), { text: clean, source: 'you', now })
  if (result.full) return fail(409, `The idea shelf for ${project.name} is full (${MAX_IDEAS} ideas). Remove some first.`)
  return done(result.duplicate ? `Already shelved: ${result.idea.text}` : `Shelved: ${result.idea.text}`, { id: result.idea.id, duplicate: result.duplicate })
}

function ideaRemove(store, { projectId, id }, { now }) {
  if (!projectRef(store, projectId)) return noProject(projectId)
  const { removed } = removeIdeas(store, { projectId }, [id], { now })
  return removed.length ? done(`Removed: ${removed[0].text}`, { removed: id }) : fail(404, NO_IDEA)
}

function ideaRestore(store, { projectId, id }, { now }) {
  if (!projectRef(store, projectId)) return noProject(projectId)
  const { restored, missing } = restoreIdeas(store, { projectId }, [id], { now })
  if (restored.length) return done(`Restored: ${restored[0].text}`, { restored: id })
  return missing[0]?.reason === 'not taken' ? fail(409, 'That idea is not taken.') : fail(404, NO_IDEA)
}

function ideaPrompt(store, { projectId, id }) {
  if (!projectRef(store, projectId)) return noProject(projectId)
  const idea = readShelf(store, { projectId }).ideas.find((one) => one.id === id)
  if (!idea) return fail(404, NO_IDEA)
  const prompt = promptFor([idea])
  return done(prompt, { prompt })
}

// `agent-mods assumptions right|wrong <id> --fix=<text>`: judgeItem with by 'user', the fix read only
// for a wrong verdict, and the CLI's report as the reply.
function assumptionVerdict(store, { projectId, id, verdict, fix }, { now }) {
  const project = projectRef(store, projectId)
  if (!project) return noProject(projectId)
  const correction = verdict === 'wrong' ? cleanCorrection(fix) : ''
  const out = judgeItem(store, project, now, { id, newest: false, verdict, correction, by: 'user' })
  if (out.error) return fail(404, out.error)
  return done(verdictReport(store, out), {
    item: { id: out.item.id, verdict: out.item.verdict, note: out.item.note ?? null },
    rule: out.change ? { kind: out.change.kind, id: out.change.rule.id } : null,
  })
}

// `agent-mods rules delete <id>`, with its reply.
function ruleDelete(store, { projectId, id }, { now }) {
  const project = projectRef(store, projectId)
  if (!project) return noProject(projectId)
  const out = deleteRule(store, project, now, id)
  if (!out) return fail(404, `No rule #${id} in ${project.name}.`)
  return done(`Rule #${id} deleted: ${out.rule.correction} (not: "${out.rule.assumption}"). ${plural(out.rules.length, 'rule')} left.`, { deleted: id, rules: out.rules.length })
}

// A targeted command saves that session's hat under sessions/<key>/, so the key must match the
// session-key shape (checked before this runs) and name an existing record.
function clawd(store, { verb, arg, key }, { now }) {
  if (verb === 'hat' && arg !== 'random' && !validHat(arg)) return fail(400, `hat needs a hat name or random: ${WEARABLE.join(', ')}.`)
  if (verb !== 'hat' && arg !== null && arg !== '') return fail(400, `${verb} takes no arg.`)
  let target = null
  let project = { projectId: null, name: '' }
  if (key) {
    const record = readRecord(store, key)
    if (!record) return fail(404, NO_SESSION)
    target = { agent: record.agent, key }
    project = { projectId: typeof record.projectId === 'string' ? record.projectId : null, name: projectOf(record.repoKey ?? record.cwd ?? '') }
  }
  const result = runCommand({ store, now, project, target, agent: FROM.agent, input: verb === 'hat' ? `hat ${arg}` : verb })
  return done(result.text, result.data)
}

function notify(store, { enabled }) {
  setConfigValue(store, 'notify.enabled', enabled)
  return done(enabled ? 'Finish alerts are on.' : 'Finish alerts are off.', notifySettings(loadConfig(store)))
}

function plain(store, { level }) {
  const result = runPlainCommand(store, { action: 'level', level })
  return done(result.text, result.data)
}

const PROJECT = { projectId: required(projectIdField) }
const IDEA = { ...PROJECT, id: required(ideaIdField) }

const ACTIONS = {
  send: { fields: { key: required(sessionKeyField), text: required(stringUpTo(TEXT_RAW_MAX)) }, run: send },
  continue: { fields: { key: required(sessionKeyField), text: required(stringUpTo(TEXT_RAW_MAX)) }, run: continueSend },
  'idea.add': { fields: { ...PROJECT, text: required(stringUpTo(TEXT_RAW_MAX)) }, run: ideaAdd },
  'idea.remove': { fields: IDEA, run: ideaRemove },
  'idea.restore': { fields: IDEA, run: ideaRestore },
  'idea.prompt': { fields: IDEA, run: ideaPrompt },
  'assumption.verdict': {
    fields: { ...PROJECT, id: required(wholeNumber), verdict: required(oneOf(['right', 'wrong'])), fix: optional(stringUpTo(FIX_MAX)) },
    run: assumptionVerdict,
  },
  'rule.delete': { fields: { ...PROJECT, id: required(wholeNumber) }, run: ruleDelete },
  clawd: { fields: { verb: required(oneOf(CLAWD_VERBS)), arg: optional(stringUpTo(ARG_MAX)), key: optional(sessionKeyField) }, run: clawd },
  notify: { fields: { enabled: required(boolean) }, run: notify },
  plain: { fields: { level: required(oneOf(LEVELS)) }, run: plain },
}

export function runAction(store, body, { now = Date.now() } = {}) {
  if (!isObject(body)) return fail(400, 'The action must be a JSON object with a type.')
  const { type } = body
  if (typeof type !== 'string') return fail(400, 'The action needs a type.')
  if (!Object.hasOwn(ACTIONS, type)) return fail(400, `Unknown action type: ${peerText(type, 40)}.`)
  const action = ACTIONS[type]
  const unknown = Object.keys(body).find((name) => name !== 'type' && !Object.hasOwn(action.fields, name))
  if (unknown !== undefined) return fail(400, `Unknown field for ${type}: ${peerText(unknown, 40)}.`)
  const args = {}
  for (const [name, check] of Object.entries(action.fields)) {
    const out = check(body[name], name)
    if (out.error) return fail(400, out.error)
    args[name] = out.value
  }
  try {
    return action.run(store, args, { now })
  } catch (err) {
    if (err?.code === 'ELOCKTIMEOUT') return fail(503, 'Another agent is changing that file right now. Try again.')
    logError(store, `dashboard: action ${type}: ${err?.stack ?? err}`)
    return fail(500, 'That did not work. The error is in the agent-mods error log (logs/errors.log).')
  }
}
