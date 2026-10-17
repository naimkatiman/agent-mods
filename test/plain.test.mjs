import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { contextOf, hook, makeRepo, mcpClient, SESSION_IDS, tempStore } from './helpers.mjs'
import { runCli } from '../lib/core/cli.mjs'
import { CODE_ROOT } from '../lib/core/paths.mjs'
import { loadConfig, sessionKey, sessionState, setConfigValue } from '../lib/core/store.mjs'
import plainDefault, {
  buildReviewPrompt,
  cleanTerm,
  cleanTerms,
  createPlain,
  gradeText,
  isOfferable,
  knownTermsNote,
  mergeTerms,
  notifySettings,
  parsePlainArgs,
  parseReview,
  readSettings,
  rewriteText,
  rulesText,
  runPlainCommand,
  untoldTerms,
} from '../lib/mods/plain.mjs'
import { LEVELS, REVIEW_SYSTEM, rulesFor } from '../lib/mods/plain-rules.mjs'
import { DONE_WAV, NOTIFY_RUNNER, NOTIFY_SCRIPT, launchNotifier, notifierArgs, runNotifier } from '../lib/mods/plain-notify.mjs'

const AGENTS = ['claude', 'codex', 'grok', 'devin']
const LABEL = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok', devin: 'Devin' }
const T0 = Date.UTC(2026, 9, 11, 9, 0, 0)

// A spawner that records instead of starting PowerShell.
function fakeSpawner() {
  const calls = []
  const spawner = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return { on() {}, unref() {} }
  }
  return { calls, spawner }
}

function setup({ level, terms, notify } = {}) {
  const { root, env, store } = tempStore()
  if (level !== undefined || terms !== undefined) store.writeJson('plain.json', { level, terms })
  if (notify) for (const [key, value] of Object.entries(notify)) setConfigValue(store, `notify.${key}`, value)
  const { calls, spawner } = fakeSpawner()
  const mod = createPlain({ spawner, platform: 'win32' })
  return { root, env, store, mod, calls, cwd: makeRepo('shop') }
}

const stateOf = (store, agent) => sessionState(store, sessionKey(agent, SESSION_IDS[agent]), 'plain').read({})

function capture() {
  let out = ''
  let err = ''
  return {
    stdout: { write: (s) => { out += s } },
    stderr: { write: (s) => { err += s } },
    get out() { return out },
    get err() { return err },
  }
}

async function cli(mod, env, argv) {
  const io = capture()
  const code = await runCli({ argv, env, stdout: io.stdout, stderr: io.stderr, mods: [mod] })
  return { code, out: io.out, err: io.err }
}

// --- rules text --------------------------------------------------------------------------------

const RULES_TS = path.join(CODE_ROOT, 'claude-mods', 'basic-claude', 'hooks', 'rules.ts')

test('rules text is rules.ts verbatim, with only the session wording made agent-neutral', { skip: !fs.existsSync(RULES_TS) }, () => {
  const src = fs.readFileSync(RULES_TS, 'utf8').replace(/\r\n/g, '\n')
  const pick = (name) => new RegExp(`const ${name} = \`([\\s\\S]*?)\``).exec(src)[1]
  const standalone = pick('STANDALONE')
  assert.ok(standalone.includes('several Claude Code sessions'))
  const ported = standalone.replace('several Claude Code sessions', 'several agent sessions')
  assert.equal(rulesFor('beginner'), `# Plain talk\n\n${pick('PLAIN')}\n\n${ported}`)
  assert.equal(rulesFor('expert'), `# Plain talk\n\n${pick('EXPERT')}\n\n${ported}`)
  assert.equal(REVIEW_SYSTEM, pick('REVIEW_SYSTEM'))
})

test('rules per level: beginner explains, expert does not, off has no section', () => {
  assert.deepEqual(LEVELS, ['beginner', 'expert', 'off'])
  const beginner = rulesFor('beginner')
  assert.match(beginner, /^# Plain talk\n\n## Plain words/)
  assert.ok(beginner.includes('Your next step'))
  assert.ok(beginner.includes('several agent sessions'))
  assert.ok(!beginner.includes('Claude'))
  const expert = rulesFor('expert')
  assert.ok(expert.includes('## Clear words') && !expert.includes('## Plain words'))
  assert.ok(expert.includes('Your next step'))
  assert.equal(rulesFor('off'), null)
  assert.ok(rulesText('off', ['api']).startsWith('plain-talk is off'))
  assert.equal(rulesText('expert', ['api']), rulesFor('expert'))
  assert.equal(rulesText('beginner', []), rulesFor('beginner'))
  assert.equal(rulesText('beginner', ['api', 'git']), `${rulesFor('beginner')}\n\n${knownTermsNote(['api', 'git'])}`)
})

test('level defaults to off (deliberate deviation); a bad stored level falls back to off', () => {
  const { store } = tempStore()
  assert.deepEqual(readSettings(store), { level: 'off', terms: [] })
  store.writeJson('plain.json', { level: 'loud', terms: 'not a list' })
  assert.deepEqual(readSettings(store), { level: 'off', terms: [] })
  store.writeJson('plain.json', { level: 'expert', terms: ['api'] })
  assert.deepEqual(readSettings(store), { level: 'expert', terms: ['api'] })
})

// --- glossary ----------------------------------------------------------------------------------

test('cleanTerm keeps the term before a colon, lowercased, at most three words', () => {
  assert.equal(cleanTerm('Next.js: a popular tool'), 'next.js')
  assert.equal(cleanTerm('  Pull   Request '), 'pull request')
  assert.equal(cleanTerm('merge conflict: when two edits clash'), 'merge conflict')
  assert.equal(cleanTerm('a'), null)
  assert.equal(cleanTerm('four words are here'), null)
  assert.deepEqual(cleanTerms(['API', 'api', 42, null, 'x', 'Git']), ['api', 'git'])
})

test('old sentence-style saved terms are cleaned on read and written back once', () => {
  const { store } = tempStore()
  store.writeJson('plain.json', {
    level: 'beginner',
    terms: ['next.js: a popular tool for building web apps', 'next.js', 'order status is simulated on a timer, not set by staff', 'Git', 'built-in file-editing tool'],
  })
  let updates = 0
  const counting = { ...store, update: (...args) => (updates++, store.update(...args)) }
  const { text } = runPlainCommand(counting, parsePlainArgs('know'))
  assert.equal(text, 'Terms you know: next.js, git, built-in file-editing tool')
  assert.equal(updates, 1)
  assert.deepEqual(store.readJson('plain.json'), { level: 'beginner', terms: ['next.js', 'git', 'built-in file-editing tool'] })
  // Already tidy: a second read writes nothing.
  runPlainCommand(counting, parsePlainArgs('know'))
  assert.equal(updates, 1)
})

test('mergeTerms appends only new cleaned terms and keeps the newest 300', () => {
  assert.deepEqual(mergeTerms(['api'], ['API', 'Git: version control', 'git']), { added: ['git'], terms: ['api', 'git'] })
  const known = Array.from({ length: 300 }, (_, i) => `term${i}`)
  const { added, terms } = mergeTerms(known, ['fresh'])
  assert.deepEqual(added, ['fresh'])
  assert.equal(terms.length, 300)
  assert.equal(terms[0], 'term1')
  assert.equal(terms[299], 'fresh')
})

test('meta words and non-terms are never offered as "I know this"', () => {
  const explained = ['plain-talk', 'Jargon', 'Your next step', 'merge conflict: when two edits clash', 'a sentence that is far too long', 'api']
  const review = parseReview(JSON.stringify({ status: 'Answered', pass: true, problems: [], explained }))
  assert.deepEqual(review.explained, ['merge conflict', 'api'])
  assert.equal(isOfferable('x'.repeat(41)), false)
  assert.equal(isOfferable('the plain-talk band'), false)
  assert.equal(isOfferable('api'), true)
})

// --- grading -----------------------------------------------------------------------------------

test('gradeText: check, nits, problems, rewriting, one-line cut', () => {
  assert.equal(gradeText({ pass: true, problems: [], offered: [], isFixing: false }), '✓ plain')
  assert.equal(gradeText({ pass: true, problems: ['no Done/Not done ending'], offered: [], isFixing: false }), '✓ plain · nit: no Done/Not done ending')
  assert.equal(gradeText({ pass: false, problems: ['says see above'], offered: [], isFixing: false }), '✗ 1 problem: says see above')
  assert.equal(gradeText({ pass: false, problems: ['says see above'], offered: [], isFixing: true }), '✗ 1 problem: says see above · rewriting')
  assert.equal(gradeText({ pass: false, problems: ['a', 'b'], offered: [], isFixing: false }), '✗ 2 problems: a; b')
  assert.equal(gradeText({ pass: false, problems: [], offered: [], isFixing: false }), '✗ not plain')
  const long = gradeText({ pass: false, problems: ['x'.repeat(100)], offered: [], isFixing: true })
  assert.equal(long, `${`✗ 1 problem: ${'x'.repeat(100)}`.slice(0, 79)}… · rewriting`)
  assert.equal(gradeText({ pass: true, problems: ['y'.repeat(100)], offered: [], isFixing: false }).length, 80)
})

test('parseReview is lenient: prose around JSON, missing pass, bad shapes', () => {
  const FAIL = '{"status":"Fixing login bug: needs your OK","pass":false,"problems":["says see above"],"explained":["api","git branch"]}'
  assert.deepEqual(parseReview(`Here you go:\n${FAIL}\nthanks`), {
    status: 'Fixing login bug: needs your OK',
    pass: false,
    problems: ['says see above'],
    explained: ['api', 'git branch'],
  })
  // A missing "pass" counts as a pass (original behaviour, kept on purpose).
  assert.equal(parseReview('{"status":"ok"}').pass, true)
  assert.deepEqual(parseReview('{"problems":[1,true],"explained":"api"}'), { status: '', pass: true, problems: ['1', 'true'], explained: [] })
  assert.equal(parseReview(`{"status":"${'s'.repeat(150)}"}`).status.length, 100)
  assert.equal(parseReview('no json here'), null)
  assert.equal(parseReview('{broken'), null)
  assert.equal(parseReview(undefined), null)
})

test('the reviewer prompt names the request, the known terms and the final message', () => {
  const prompt = buildReviewPrompt('beginner', ['plugin', 'git'], 'Explain CRDTs using the proper technical terms', 'A CRDT is...')
  assert.equal(
    prompt,
    "Reader level: beginner.\nTerms the reader already knows (not jargon): plugin, git.\n\nThe user's request for this turn (if it asks for technical terms, detail or exact wording, giving that passes):\n<user_request>\nExplain CRDTs using the proper technical terms\n</user_request>\n\n<final_message>\nA CRDT is...\n</final_message>",
  )
  assert.ok(buildReviewPrompt('expert', [], '', 'x').includes('<user_request>\n(none)\n</user_request>'))
  assert.ok(!buildReviewPrompt('expert', [], '', 'x').includes('already knows'))
  assert.ok(REVIEW_SYSTEM.includes('explicitly asks for technical terms'))
  assert.ok(REVIEW_SYSTEM.includes('Style nits NEVER fail'))
  assert.equal(
    rewriteText(['says see above']),
    '[plain-talk] Your last message may confuse the user: says see above. Rewrite it as one complete final message that fixes only that, still giving everything the user asked for. Do not run any tools.',
  )
  assert.ok(rewriteText([]).includes('confuse the user: not plain enough.'))
})

// --- /plain command ----------------------------------------------------------------------------

test('/plain parser and reply texts', () => {
  const { store } = tempStore()
  const run = (args) => runPlainCommand(store, parsePlainArgs(args)).text
  assert.equal(
    run(''),
    'plain-talk level: off. Terms you know: 0.\nUse /plain beginner, /plain expert, /plain off, /plain know <term> (comma-separate several; no term lists them), or /plain forget to clear the term list.',
  )
  assert.equal(run('know'), 'You have not marked any terms as known yet. Use /plain know <term>.')
  assert.equal(run('know API, Pull Request'), 'plain-talk will treat these as known: api, pull request')
  assert.equal(run('know api'), 'plain-talk already knew those terms.')
  assert.ok(run('').includes('Terms you know: 2'))
  assert.equal(run('know'), 'Terms you know: api, pull request')
  assert.equal(run('EXPERT'), 'plain-talk is now: expert')
  assert.equal(readSettings(store).level, 'expert')
  // A level word must be the only argument.
  assert.ok(run('off please').startsWith('plain-talk level: expert.'))
  assert.ok(run('bogus').startsWith('plain-talk level: expert.'))
  assert.equal(run('forget'), 'plain-talk forgot every term you knew.')
  assert.deepEqual(readSettings(store), { level: 'expert', terms: [] })
  assert.deepEqual(parsePlainArgs('know a sentence that is far too long, ok go'), { action: 'know', terms: ['ok go'] })
})

// --- hooks: style rules ------------------------------------------------------------------------

test('SessionStart: level off adds nothing, for every agent', async () => {
  const { env, mod, cwd, store } = setup()
  for (const agent of AGENTS) {
    const reply = await hook(agent, 'SessionStart', {}, { cwd, env, mods: [mod] })
    assert.equal(reply.raw, '', agent)
  }
  // Nothing was queued for Grok either.
  const post = await hook('grok', 'PostToolUse', { tool: 'edit', file: path.join(cwd, 'src', 'a.ts') }, { cwd, env, mods: [mod] })
  assert.equal(contextOf(post), '')
  // And no per-session state is written for a mod that is off.
  for (const agent of AGENTS) assert.deepEqual(stateOf(store, agent), {}, agent)
})

test('SessionStart: beginner rules plus every known term, at once for Claude, Codex and Devin', async () => {
  const { env, mod, cwd, store } = setup({ level: 'beginner', terms: ['api', 'git'] })
  for (const agent of ['claude', 'codex', 'devin']) {
    const reply = await hook(agent, 'SessionStart', {}, { cwd, env, mods: [mod] })
    assert.equal(contextOf(reply), `${rulesFor('beginner')}\n\n${knownTermsNote(['api', 'git'])}`, agent)
    assert.equal(stateOf(store, agent).told, 2, agent)
  }
  assert.equal(knownTermsNote(['api', 'git']), 'plain-talk: the user already understands these terms, so use them without re-explaining: api, git')
})

test('SessionStart: Grok gets the rules with its next PostToolUse (runtime queue)', async () => {
  const { env, mod, cwd } = setup({ level: 'expert', terms: ['api'] })
  const start = await hook('grok', 'SessionStart', {}, { cwd, env, mods: [mod] })
  assert.equal(start.raw, '')
  const post = await hook('grok', 'PostToolUse', { tool: 'edit', file: path.join(cwd, 'src', 'a.ts') }, { cwd, env, mods: [mod] })
  assert.equal(contextOf(post), rulesFor('expert'))
  const again = await hook('grok', 'PostToolUse', { tool: 'edit', file: path.join(cwd, 'src', 'a.ts') }, { cwd, env, mods: [mod] })
  assert.equal(contextOf(again), '')
})

test('SessionStart: expert sends the rules only, never the term list', async () => {
  const { env, mod, cwd } = setup({ level: 'expert', terms: ['api'] })
  for (const agent of ['claude', 'codex', 'devin']) {
    const reply = await hook(agent, 'SessionStart', {}, { cwd, env, mods: [mod] })
    assert.equal(contextOf(reply), rulesFor('expert'), agent)
    const prompt = await hook(agent, 'UserPromptSubmit', { prompt: 'hi' }, { cwd, env, mods: [mod] })
    assert.equal(contextOf(prompt), '', agent)
  }
})

// --- hooks: known-terms delta ------------------------------------------------------------------

test('UserPromptSubmit at beginner tells only the terms added since the session was told', async () => {
  const { env, mod, cwd, store } = setup({ level: 'beginner', terms: ['api'] })
  for (const agent of ['claude', 'codex', 'devin']) {
    await hook(agent, 'SessionStart', {}, { cwd, env, mods: [mod] })
  }
  runPlainCommand(store, parsePlainArgs('know git'))
  for (const agent of ['claude', 'codex', 'devin']) {
    const first = await hook(agent, 'UserPromptSubmit', { prompt: 'hi' }, { cwd, env, mods: [mod] })
    assert.equal(contextOf(first), knownTermsNote(['git']), agent)
    const second = await hook(agent, 'UserPromptSubmit', { prompt: 'and then?' }, { cwd, env, mods: [mod] })
    assert.equal(contextOf(second), '', agent)
  }
})

test('known-terms delta reaches Grok through the queue', async () => {
  const { env, mod, cwd, store } = setup({ level: 'beginner', terms: [] })
  await hook('grok', 'SessionStart', {}, { cwd, env, mods: [mod] })
  runPlainCommand(store, parsePlainArgs('know pull request'))
  const prompt = await hook('grok', 'UserPromptSubmit', { prompt: 'hi' }, { cwd, env, mods: [mod] })
  assert.equal(prompt.raw, '')
  const post = await hook('grok', 'PostToolUse', { tool: 'edit', file: path.join(cwd, 'src', 'a.ts') }, { cwd, env, mods: [mod] })
  assert.equal(contextOf(post), `${rulesFor('beginner')}\n\n${knownTermsNote(['pull request'])}`)
})

test('known-terms delta survives a forget and re-add from another terminal', async () => {
  const { env, mod, cwd, store } = setup({ level: 'beginner', terms: ['api', 'git'] })
  await hook('claude', 'SessionStart', {}, { cwd, env, mods: [mod] })
  // Forget, then three new terms, before this session's next prompt: a bare count (2) would have
  // told only the third.
  runPlainCommand(store, parsePlainArgs('forget'))
  runPlainCommand(store, parsePlainArgs('know docker, yaml, cron'))
  const prompt = await hook('claude', 'UserPromptSubmit', { prompt: 'hi' }, { cwd, env, mods: [mod] })
  assert.equal(contextOf(prompt), knownTermsNote(['docker', 'yaml', 'cron']))
  // Forget with a prompt in between, then one term.
  runPlainCommand(store, parsePlainArgs('forget'))
  assert.equal(contextOf(await hook('claude', 'UserPromptSubmit', { prompt: 'x' }, { cwd, env, mods: [mod] })), '')
  runPlainCommand(store, parsePlainArgs('know redis'))
  assert.equal(contextOf(await hook('claude', 'UserPromptSubmit', { prompt: 'y' }, { cwd, env, mods: [mod] })), knownTermsNote(['redis']))
  assert.deepEqual(untoldTerms(['a', 'b', 'c'], { told: 2, toldLast: 'b' }), ['c'])
  assert.deepEqual(untoldTerms(['a', 'x', 'c'], { told: 2, toldLast: 'b' }), ['a', 'x', 'c'])
  assert.deepEqual(untoldTerms(['a'], { told: 2, toldLast: 'b' }), ['a'])
  assert.deepEqual(untoldTerms(['a'], null), ['a'])
})

test('switching to beginner mid-session tells the whole list on the next prompt', async () => {
  const { env, mod, cwd, store } = setup({ level: 'expert', terms: ['api', 'git'] })
  await hook('codex', 'SessionStart', {}, { cwd, env, mods: [mod] })
  runPlainCommand(store, parsePlainArgs('beginner'))
  const prompt = await hook('codex', 'UserPromptSubmit', { prompt: 'hi' }, { cwd, env, mods: [mod] })
  assert.equal(contextOf(prompt), knownTermsNote(['api', 'git']))
})

test('UserPromptSubmit keeps the last real ask across a blank continuation and stamps the turn', async () => {
  const { env, mod, cwd, store } = setup()
  await hook('claude', 'UserPromptSubmit', { prompt: 'deploy   the\nworker' }, { cwd, env, mods: [mod], now: T0 })
  assert.deepEqual(stateOf(store, 'claude'), { lastAsk: 'deploy the worker', turnStartedAt: T0 })
  await hook('claude', 'UserPromptSubmit', { prompt: '  ' }, { cwd, env, mods: [mod], now: T0 + 5000 })
  assert.deepEqual(stateOf(store, 'claude'), { lastAsk: 'deploy the worker', turnStartedAt: T0 + 5000 })
  await hook('claude', 'UserPromptSubmit', { prompt: 'x'.repeat(5000) }, { cwd, env, mods: [mod], now: T0 + 9000 })
  assert.equal(stateOf(store, 'claude').lastAsk.length, 200)
  // Subagent prompts are not the user's ask.
  await hook('claude', 'UserPromptSubmit', { prompt: 'sub', isSubagent: true }, { cwd, env, mods: [mod], now: T0 + 9999 })
  assert.equal(stateOf(store, 'claude').turnStartedAt, T0 + 9000)
})

// --- hooks: finish alerts ----------------------------------------------------------------------

async function turn(agent, ctx, { prompt = 'fix the login bug', took = 31_000, stopFields = {}, env = {} } = {}) {
  await hook(agent, 'UserPromptSubmit', { prompt }, { cwd: ctx.cwd, env: { ...ctx.env, ...env }, mods: [ctx.mod], now: ctx.now })
  const reply = await hook(agent, 'Stop', stopFields, { cwd: ctx.cwd, env: { ...ctx.env, ...env }, mods: [ctx.mod], now: ctx.now + took })
  ctx.now += took + 1000
  return reply
}

// The hook starts the runner (plain-notify.mjs) detached under node: [runner, title, message, sound].
const alertOf = (call) => ({ title: call.args[1], message: call.args[2], sound: call.args[3] })

test('Stop after a long turn starts the notifier runner detached and does not wait', async () => {
  const ctx = { ...setup({ notify: { enabled: true } }), now: T0 }
  const reply = await turn('claude', ctx)
  assert.equal(reply.raw, '')
  assert.equal(ctx.calls.length, 1)
  const [call] = ctx.calls
  assert.equal(call.cmd, process.execPath)
  assert.deepEqual(call.args, [NOTIFY_RUNNER, 'Claude Code finished and needs you', 'shop: fix the login bug', DONE_WAV])
  assert.deepEqual(call.opts, { detached: true, stdio: 'ignore', windowsHide: true })
})

// A child that exits when told to, or never.
function fakeChild() {
  const child = new EventEmitter()
  child.killed = false
  child.kill = () => {
    child.killed = true
  }
  return child
}

test('runner starts PowerShell attached and hidden with the exact command, and waits for it', async () => {
  const calls = []
  const child = fakeChild()
  const spawner = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return child
  }
  const done = runNotifier(['Codex finished and needs you', 'shop: fix it', DONE_WAV], { spawner })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cmd, 'powershell.exe')
  assert.deepEqual(calls[0].args, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', NOTIFY_SCRIPT, '-Title', 'Codex finished and needs you', '-Message', 'shop: fix it', '-Sound', DONE_WAV,
  ])
  // Not detached: a detached PowerShell 5.1 has no console and runs nothing.
  assert.deepEqual(calls[0].opts, { stdio: 'ignore', windowsHide: true })
  child.emit('exit', 0)
  assert.equal(await done, true)

  // No sound: no -Sound argument. A hung PowerShell is killed at the timeout.
  const hung = fakeChild()
  const quiet = runNotifier(['t', 'm', ''], { spawner: (cmd, args) => (calls.push({ cmd, args }), hung), timeoutMs: 20 })
  assert.ok(!calls[1].args.includes('-Sound'))
  assert.equal(await quiet, false)
  assert.equal(hung.killed, true)

  // A spawn that throws or errors resolves false instead of crashing the runner.
  assert.equal(await runNotifier(['t', 'm'], { spawner: () => { throw new Error('EINVAL') } }), false)
  const broken = fakeChild()
  const failing = runNotifier(['t', 'm'], { spawner: () => broken })
  broken.emit('error', new Error('ENOENT'))
  assert.equal(await failing, false)
})

test('finish alert decision: enabled, threshold, subagent, attended, once per turn', async () => {
  const off = { ...setup(), now: T0 }
  await turn('claude', off)
  assert.equal(off.calls.length, 0, 'disabled by default')

  const ctx = { ...setup({ notify: { enabled: true } }), now: T0 }
  await turn('claude', ctx, { took: 30_000 })
  assert.equal(ctx.calls.length, 0, 'exactly the threshold is not longer than it')
  await turn('claude', ctx, { stopFields: { isSubagent: true } })
  assert.equal(ctx.calls.length, 0, 'subagent stop')
  await turn('claude', ctx, { env: { CLAUDE_CODE_SESSION_ATTENDED: '0' } })
  assert.equal(ctx.calls.length, 0, 'unattended (headless) session')
  await turn('claude', ctx, { env: { CLAUDE_CODE_SESSION_ATTENDED: '1' } })
  assert.equal(ctx.calls.length, 1, 'attended session')

  // A Stop hook that blocked makes the agent stop again in the same turn: still one alert.
  await hook('claude', 'UserPromptSubmit', { prompt: 'again' }, { cwd: ctx.cwd, env: ctx.env, mods: [ctx.mod], now: ctx.now })
  await hook('claude', 'Stop', {}, { cwd: ctx.cwd, env: ctx.env, mods: [ctx.mod], now: ctx.now + 40_000 })
  await hook('claude', 'Stop', { stopHookActive: true }, { cwd: ctx.cwd, env: ctx.env, mods: [ctx.mod], now: ctx.now + 50_000 })
  assert.equal(ctx.calls.length, 2)

  // No UserPromptSubmit seen for this session: nothing to time, no alert.
  const fresh = setup({ notify: { enabled: true } })
  await hook('devin', 'Stop', {}, { cwd: fresh.cwd, env: fresh.env, mods: [fresh.mod], now: T0 })
  assert.equal(fresh.calls.length, 0)
})

test('finish alert: an earlier mod blocking the Stop means the turn is not over', async () => {
  const ctx = setup({ notify: { enabled: true } })
  const blocker = { name: 'blocker', hooks: { Stop: (c) => { if (!c.ev.stopHookActive) c.out.block = 'keep going' } } }
  await hook('claude', 'UserPromptSubmit', { prompt: 'p' }, { cwd: ctx.cwd, env: ctx.env, mods: [blocker, ctx.mod], now: T0 })
  const first = await hook('claude', 'Stop', {}, { cwd: ctx.cwd, env: ctx.env, mods: [blocker, ctx.mod], now: T0 + 40_000 })
  assert.deepEqual(first.json, { decision: 'block', reason: 'keep going' })
  assert.equal(ctx.calls.length, 0)
  await hook('claude', 'Stop', { stopHookActive: true }, { cwd: ctx.cwd, env: ctx.env, mods: [blocker, ctx.mod], now: T0 + 60_000 })
  assert.equal(ctx.calls.length, 1)
})

test('finish alert: every agent names itself; threshold and sound come from config', async () => {
  const ctx = { ...setup({ notify: { enabled: true, afterMs: 5000, sound: false } }), now: T0 }
  for (const agent of AGENTS) {
    await turn(agent, ctx, { took: 6000, prompt: 'ship the release notes' })
  }
  assert.equal(ctx.calls.length, 4)
  ctx.calls.forEach((call, i) => {
    assert.deepEqual(alertOf(call), { title: `${LABEL[AGENTS[i]]} finished and needs you`, message: 'shop: ship the release notes', sound: '' })
  })
})

test('finish alert message: project name plus the ask clipped to 80 characters', async () => {
  const ctx = { ...setup({ notify: { enabled: true } }), now: T0 }
  await turn('codex', ctx, { prompt: `please ${'refactor '.repeat(20)}` })
  const { message } = alertOf(ctx.calls[0])
  assert.ok(message.startsWith('shop: please refactor'))
  assert.equal(message.length, 'shop: '.length + 80)
  assert.ok(message.endsWith('…'))
})

test('notifierArgs guards values PowerShell would bind as parameter names', () => {
  const args = notifierArgs({ title: 'T', message: '-tmp: fix it', sound: null })
  assert.equal(args[args.indexOf('-Message') + 1], ' -tmp: fix it')
  assert.ok(!args.includes('-Sound'))
  assert.equal(notifierArgs({ title: 'T', message: 'a "quoted" & <odd> message…' }).at(-1), 'a "quoted" & <odd> message…')
})

test('launchNotifier: nothing off Windows, false when spawning throws', () => {
  const { calls, spawner } = fakeSpawner()
  assert.equal(launchNotifier({ title: 't', message: 'm' }, { spawner, platform: 'linux' }), false)
  assert.equal(launchNotifier({ title: 't', message: 'm' }, { spawner, platform: 'darwin' }), false)
  assert.equal(calls.length, 0)
  const boom = () => {
    throw new Error('EINVAL')
  }
  assert.equal(launchNotifier({ title: 't', message: 'm' }, { spawner: boom, platform: 'win32' }), false)
  assert.equal(launchNotifier({ title: 't', message: 'm' }, { spawner, platform: 'win32' }), true)
  assert.equal(calls.length, 1)
})

test('notifySettings: defaults, and a bad afterMs falls back to 30 s', () => {
  const { store } = tempStore()
  assert.deepEqual(notifySettings(loadConfig(store)), { enabled: false, afterMs: 30_000, sound: true })
  assert.deepEqual(notifySettings({ notify: { enabled: true, afterMs: 'soon', sound: false } }), { enabled: true, afterMs: 30_000, sound: false })
})

// --- MCP ---------------------------------------------------------------------------------------

test('mcp: the plain tool covers status, level, know, forget and rules', async () => {
  const { env, mod } = setup()
  const client = mcpClient({ mods: [mod], env, clientName: 'codex-mcp-client' })
  await client.init()
  const list = await client.call('tools/list', {})
  const tool = list.result.tools.find((t) => t.name === 'plain')
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['status', 'level', 'know', 'forget', 'rules', 'review'])
  assert.deepEqual(tool.inputSchema.required, ['action'])

  const text = async (args) => (await client.tool('plain', args)).content[0].text
  assert.ok((await text({ action: 'status' })).startsWith('plain-talk level: off. Terms you know: 0.\nUse /plain beginner'))
  assert.equal(await text({ action: 'rules' }), rulesText('off', []))
  assert.equal(await text({ action: 'level', level: 'expert' }), 'plain-talk is now: expert')
  assert.equal(await text({ action: 'rules' }), rulesFor('expert'))
  const bad = await client.tool('plain', { action: 'level', level: 'loud' })
  assert.equal(bad.isError, true)
  assert.equal(await text({ action: 'level', level: 'beginner' }), 'plain-talk is now: beginner')
  assert.equal(await text({ action: 'know', terms: 'API, Pull Request' }), 'plain-talk will treat these as known: api, pull request')
  assert.equal(await text({ action: 'know', terms: ['git', 'api'] }), 'plain-talk will treat these as known: git')
  assert.equal(await text({ action: 'know' }), 'Terms you know: api, pull request, git')
  assert.equal(await text({ action: 'rules' }), `${rulesFor('beginner')}\n\n${knownTermsNote(['api', 'pull request', 'git'])}`)
  assert.equal(await text({ action: 'rules', level: 'expert' }), rulesFor('expert'))
  const status = await client.tool('plain', { action: 'status' })
  assert.deepEqual(status.data, { level: 'beginner', termsCount: 3 })
  assert.equal(await text({ action: 'forget' }), 'plain-talk forgot every term you knew.')
  assert.equal((await client.tool('plain', { action: 'nope' })).isError, true)
  client.close()
})

test('mcp: review hands the rubric to the caller, then turns its grade into the grade line', async () => {
  const { env, mod, store } = setup({ level: 'beginner', terms: ['git'] })
  const client = mcpClient({ mods: [mod], env })
  await client.init()
  const missing = await client.tool('plain', { action: 'review', request: 'x' })
  assert.equal(missing.isError, true)

  const rubric = (await client.tool('plain', { action: 'review', request: 'Why did the build fail?', answer: 'Done, see above.' })).content[0].text
  assert.ok(rubric.includes(REVIEW_SYSTEM))
  assert.ok(rubric.includes(buildReviewPrompt('beginner', ['git'], 'Why did the build fail?', 'Done, see above.')))

  const FAIL = '{"status":"Fixing login bug: needs your OK","pass":false,"problems":["says see above"],"explained":["api","git","git branch","plain-talk"]}'
  const graded = await client.tool('plain', { action: 'review', grade: FAIL })
  assert.equal(
    graded.content[0].text,
    [
      '◆ Fixing login bug: needs your OK  ✗ 1 problem: says see above · rewriting',
      'I know this: api, git branch (say "/plain know <term>" to stop explanations of a term)',
      rewriteText(['says see above']),
    ].join('\n'),
  )
  assert.deepEqual(graded.data.offered, ['api', 'git branch'])
  assert.equal(graded.data.pass, false)
  // Offers are only offers: nothing was added to the known terms.
  assert.deepEqual(readSettings(store).terms, ['git'])

  const PASS = '{"status":"Explained CRDTs","pass":true,"problems":["no Done/Not done ending"],"explained":[]}'
  assert.equal((await client.tool('plain', { action: 'review', grade: PASS })).content[0].text, '◆ Explained CRDTs  ✓ plain · nit: no Done/Not done ending')
  assert.equal((await client.tool('plain', { action: 'review', grade: 'not json' })).isError, true)

  // Expert: no offers.
  const expert = await client.tool('plain', { action: 'review', grade: FAIL, level: 'expert' })
  assert.deepEqual(expert.data.offered, [])

  await client.tool('plain', { action: 'level', level: 'off' })
  const off = (await client.tool('plain', { action: 'review', request: 'x', answer: 'y' })).content[0].text
  assert.ok(off.startsWith('plain-talk is off'))
  client.close()
})

// --- CLI ---------------------------------------------------------------------------------------

test('cli: agent-mods plain', async () => {
  const { env, mod, store } = setup()
  let r = await cli(mod, env, ['plain'])
  assert.equal(r.code, 0)
  assert.ok(r.out.startsWith('plain-talk level: off. Terms you know: 0.'))
  r = await cli(mod, env, ['plain', 'expert'])
  assert.equal(r.out, 'plain-talk is now: expert\n')
  r = await cli(mod, env, ['plain', 'know', 'API,', 'Pull', 'Request'])
  assert.equal(r.out, 'plain-talk will treat these as known: api, pull request\n')
  r = await cli(mod, env, ['plain', 'know'])
  assert.equal(r.out, 'Terms you know: api, pull request\n')
  r = await cli(mod, env, ['plain', 'status', '--json'])
  assert.deepEqual(JSON.parse(r.out), { level: 'expert', termsCount: 2 })
  r = await cli(mod, env, ['plain', 'rules'])
  assert.equal(r.out, `${rulesFor('expert')}\n`)
  r = await cli(mod, env, ['plain', 'rules', 'beginner'])
  assert.equal(r.out, `${rulesText('beginner', ['api', 'pull request'])}\n`)
  r = await cli(mod, env, ['plain', 'review', '--request', 'why?', '--answer', 'Because.'])
  assert.equal(r.code, 0)
  assert.ok(r.out.includes('<final_message>\nBecause.\n</final_message>'))
  r = await cli(mod, env, ['plain', 'review', '--grade', '{"status":"ok","pass":true}'])
  assert.equal(r.out, '◆ ok  ✓ plain\n')
  r = await cli(mod, env, ['plain', 'review'])
  assert.equal(r.code, 2)
  assert.ok(r.err.startsWith('review needs'))
  r = await cli(mod, env, ['plain', 'forget'])
  assert.equal(r.out, 'plain-talk forgot every term you knew.\n')
  assert.deepEqual(store.readJson('plain.json'), { level: 'expert', terms: [] })
})

test('cli: agent-mods notify', async () => {
  const { env, mod, store, calls, cwd } = setup()
  let r = await cli(mod, env, ['notify'])
  assert.equal(r.out, 'Finish alerts are off. When on: a toast and a sound when an agent turn longer than 30 s ends.\n')
  r = await cli(mod, env, ['notify', 'on'])
  assert.equal(r.out, 'Finish alerts are on: a toast and a sound when an agent turn longer than 30 s ends.\n')
  assert.equal(loadConfig(store).notify.enabled, true)
  r = await cli(mod, env, ['notify', 'after', '45.5'])
  assert.equal(r.out, 'Finish alerts are on: a toast and a sound when an agent turn longer than 45.5 s ends.\n')
  assert.equal(loadConfig(store).notify.afterMs, 45_500)
  for (const bad of [['notify', 'after'], ['notify', 'after', ''], ['notify', 'after', 'soon'], ['notify', 'after', '-1'], ['notify', 'bogus']]) {
    r = await cli(mod, env, bad)
    assert.equal(r.code, 2, bad.join(' '))
    assert.ok(r.err.startsWith('Usage: agent-mods notify'))
  }
  r = await cli(mod, env, ['notify', 'status', '--json'])
  assert.deepEqual(JSON.parse(r.out), { enabled: true, afterMs: 45_500, sound: true })
  r = await cli(mod, env, ['notify', 'test', '--cwd', cwd])
  assert.equal(r.code, 0)
  assert.equal(calls.length, 1)
  assert.deepEqual(alertOf(calls[0]), { title: 'agent-mods test alert', message: 'This is how a finished turn is announced (shop).', sound: DONE_WAV })
  assert.equal(calls[0].opts.detached, true)
  r = await cli(mod, env, ['notify', 'off'])
  assert.equal(loadConfig(store).notify.enabled, false)

  const elsewhere = createPlain({ spawner: fakeSpawner().spawner, platform: 'linux' })
  r = await cli(elsewhere, env, ['notify', 'test'])
  assert.equal(r.code, 1)
  assert.ok(r.err.startsWith('Finish alerts work on Windows only'))
  r = await cli(elsewhere, env, ['notify'])
  assert.ok(r.out.includes('(Windows only: nothing shows on this system.)'))

  const broken = createPlain({ spawner: () => { throw new Error('ENOENT') }, platform: 'win32' })
  r = await cli(broken, env, ['notify', 'test'])
  assert.equal(r.code, 1)
  assert.ok(r.err.startsWith('Could not start the notifier'))
})

// --- wiring and assets -------------------------------------------------------------------------

test('the default export is the registered mod and runs in the hook runtime', async () => {
  assert.equal(plainDefault.name, 'plain')
  // Imported here so a sibling mod that is mid-build fails this test only, not the whole file.
  const { MODS } = await import('../lib/mods/index.mjs')
  assert.ok(MODS.includes(plainDefault))
  assert.deepEqual(Object.keys(plainDefault.hooks).sort(), ['SessionStart', 'Stop', 'UserPromptSubmit'])
  assert.deepEqual(plainDefault.tools.map((t) => t.name), ['plain'])
  assert.deepEqual(plainDefault.cli.map((c) => c.name), ['plain', 'notify'])
  // Finish alerts stay off here (the default), so the real spawner is never reached.
  const { env, store } = tempStore()
  store.writeJson('plain.json', { level: 'expert', terms: [] })
  const cwd = makeRepo('wired')
  assert.equal(contextOf(await hook('claude', 'SessionStart', {}, { cwd, env, mods: [plainDefault] })), rulesFor('expert'))
  assert.equal((await hook('claude', 'UserPromptSubmit', { prompt: 'hi' }, { cwd, env, mods: [plainDefault], now: T0 })).raw, '')
  assert.equal((await hook('claude', 'Stop', {}, { cwd, env, mods: [plainDefault], now: T0 + 60_000 })).raw, '')
})

test('assets: notify.ps1 is plain ASCII PowerShell 5.1; done.wav is 16-bit PCM WAV', () => {
  const script = fs.readFileSync(NOTIFY_SCRIPT, 'utf8')
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(script), 'ASCII only, so PowerShell 5.1 reads it without a BOM')
  for (const needle of ['[string]$Title', '[string]$Message', '[string]$Sound', '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe', 'ToastNotificationManager', 'System.Media.SoundPlayer', 'PlaySync()']) {
    assert.ok(script.includes(needle), needle)
  }
  const wav = fs.readFileSync(DONE_WAV)
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE')
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ')
  assert.equal(wav.readUInt16LE(20), 1, 'PCM')
  assert.equal(wav.readUInt16LE(22), 2, 'stereo')
  assert.equal(wav.readUInt32LE(24), 44_100)
  assert.equal(wav.readUInt16LE(34), 16)
})

test('skill: frontmatter names the skill and keeps the description to one line without angle brackets', () => {
  const text = fs.readFileSync(path.join(CODE_ROOT, 'skills', 'plain', 'SKILL.md'), 'utf8')
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  assert.ok(match)
  const fields = Object.fromEntries(match[1].split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]))
  assert.equal(fields.name, 'plain')
  assert.ok(fields.description.length > 0 && fields.description.length < 1024)
  assert.ok(!/[<>]/.test(fields.description))
  assert.ok(text.includes('agent-mods plain'), 'CLI fallback')
  assert.ok(text.includes('`plain`') || text.includes('agent-mods__plain'), 'tool named generically')
})
