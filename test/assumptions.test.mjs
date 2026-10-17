import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assumptions from '../lib/mods/assumptions.mjs'
import {
  GUIDANCE,
  KEEP_REVIEWED_MS,
  MAX_ITEMS,
  RULES_BUDGET,
  bandLabel,
  clearReviewed,
  feedbackText,
  hasUnsentWrong,
  injectedRules,
  markSent,
  newestOpen,
  prune,
  ruleEffect,
  rulesText,
  setVerdict,
  statsText,
  takeFeedback,
  withRule,
} from '../lib/mods/assumptions-logic.mjs'
import { runCli } from '../lib/core/cli.mjs'
import { projectInfo } from '../lib/core/project.mjs'
import { projectFile, sessionKey } from '../lib/core/store.mjs'
import { SESSION_IDS, contextOf, hook, makeRepo, makeWorktree, mcpClient, tempStore } from './helpers.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const ORIGINAL = path.join(ROOT, 'claude-mods', 'assumption-tracker', 'hooks', 'register.tsx')
const MODS = [assumptions]
const AGENTS = ['claude', 'codex', 'grok', 'devin']
const CLIENT = { claude: 'claude-code', codex: 'codex-mcp-client', grok: 'grok-cli', devin: 'devin-desktop' }
const NPM_RULE = { id: 1, assumption: 'uses npm', correction: 'use pnpm' }
const FEEDBACK_RIGHT = '[assumption-tracker] The user reviewed your assumptions:\n- #1 "uses npm": correct.\nAdjust your work to match. Do not log these again.'
const FEEDBACK_WRONG =
  '[assumption-tracker] The user reviewed your assumptions:\n- #1 "uses npm": WRONG. The user says: use pnpm\nAdjust your work to match. Do not log these again.'

async function cli(env, cwd, ...argv) {
  let out = ''
  let err = ''
  const code = await runCli({
    argv: [...argv, '--cwd', cwd],
    env,
    stdout: { write: (text) => (out += text) },
    stderr: { write: (text) => (err += text) },
    mods: MODS,
  })
  return { code, out, err }
}

async function withClient(env, agent, fn) {
  const client = mcpClient({ mods: MODS, env, clientName: CLIENT[agent] })
  await client.init()
  try {
    return await fn(client)
  } finally {
    client.close()
  }
}

const logAs = (env, agent, cwd, assumption, extra = {}) =>
  withClient(env, agent, (client) => client.tool('log_assumption', { assumption, cwd, session_id: SESSION_IDS[agent], ...extra }))

const textOf = (result) => result.content[0].text
const docOf = (store, cwd) => store.readJson(projectFile(projectInfo(cwd), 'assumptions.json'), null)
const edit = (cwd) => ({ tool: 'edit', file: path.join(cwd, 'src', 'a.ts') })
const on = (cwd, env, extra = {}) => ({ cwd, env, mods: MODS, ...extra })

// --- The original's pure contracts (register.test.ts) ---

const a = (id, verdict, isSent = false, note) => ({ id, text: `guess ${id}`, verdict, isSent, note })

test('feedback lists only reviewed, unsent verdicts', () => {
  const text = feedbackText([a(1, 'open'), a(2, 'right'), a(3, 'wrong', false, 'use SQLite'), a(4, 'wrong', true)])
  assert.ok(text.includes('#2 "guess 2": correct.'))
  assert.ok(text.includes('#3 "guess 3": WRONG. The user says: use SQLite'))
  assert.equal(text.includes('#1'), false)
  assert.equal(text.includes('#4'), false)
  assert.equal(
    feedbackText([a(5, 'wrong')]),
    '[assumption-tracker] The user reviewed your assumptions:\n- #5 "guess 5": WRONG. Rethink it, or ask the user what they want.\nAdjust your work to match. Do not log these again.',
  )
})

test('nothing to send gives null', () => {
  assert.equal(feedbackText([a(1, 'open'), a(2, 'right', true)]), null)
  assert.equal(feedbackText([]), null)
})

test('only an unsent wrong verdict interrupts', () => {
  assert.equal(hasUnsentWrong([a(1, 'right'), a(2, 'wrong', true)]), false)
  assert.equal(hasUnsentWrong([a(1, 'wrong')]), true)
})

test('a correction becomes a rule; an empty one does not; provenance rides along', () => {
  assert.deepEqual(withRule([], 'uses npm', '  '), [])
  assert.deepEqual(withRule([], 'uses npm'), [])
  const one = withRule([], 'uses npm', ' use pnpm ')
  assert.deepEqual(one, [NPM_RULE])
  // The same assumption corrected again updates its rule instead of adding one.
  assert.deepEqual(withRule(one, 'uses npm', 'use bun'), [{ id: 1, assumption: 'uses npm', correction: 'use bun' }])
  assert.deepEqual(withRule(one, 'tabs', 'two spaces').map((r) => r.id), [1, 2])
  const by = { agent: 'codex', sessionKey: 'codex__t1' }
  assert.deepEqual(withRule(one, 'uses npm', 'use bun', { by, at: 5 }), [{ id: 1, assumption: 'uses npm', correction: 'use bun', by, at: 5 }])
  assert.deepEqual(withRule(one, 'tabs', 'two spaces', { by: 'user', at: 6 })[1], { id: 2, assumption: 'tabs', correction: 'two spaces', by: 'user', at: 6 })
})

test('rules text and stats', () => {
  assert.equal(rulesText([]), null)
  const text = rulesText([NPM_RULE])
  assert.ok(text.includes('Project rules learned from corrected assumptions'))
  assert.ok(text.includes('- use pnpm (not: "uses npm")'))
  const rule = { id: 1, assumption: 'x', correction: 'y' }
  assert.equal(statsText([a(1, 'open'), a(2, 'wrong'), a(3, 'wrong')], [rule, { ...rule, id: 2 }]), '3 assumptions · 2 wrong · 2 rules')
  assert.equal(statsText([a(1, 'right')], [rule]), '1 assumption · 0 wrong · 1 rule')
})

test('guidance is the original text with only the documented substitutions', { skip: !fs.existsSync(ORIGINAL) }, () => {
  const source = fs.readFileSync(ORIGINAL, 'utf8')
  const original = /const GUIDANCE = `([\s\S]*?)`\n/.exec(source)[1].replace(/\\`/g, '`').replace('${TAG}', '[assumption-tracker]')
  const expected = original
    .replace('`mcp__${PLUGIN}__${TOOL}`', 'the agent-mods `log_assumption` tool')
    .replace('Do not stop to ask.', 'Keep working instead of stopping to ask, except where your instructions or the project rules tell you to ask first: then ask and log.')
    .replace('The user reviews them in a side panel.', 'The user reviews them with /assumptions or `agent-mods assumptions`.')
  assert.notEqual(expected, original)
  assert.equal(GUIDANCE, expected)
})

test('guidance uses the shared tool and follows project approval rules', () => {
  assert.ok(!GUIDANCE.includes('mcp__') && !GUIDANCE.includes('Do not stop to ask'))
})

test('rules and feedback texts match the original builders', { skip: !fs.existsSync(ORIGINAL) }, () => {
  const source = fs.readFileSync(ORIGINAL, 'utf8')
  assert.ok(source.includes('In earlier work on this project the user corrected these assumptions. Follow each rule, and do not make the original assumption again.'))
  assert.ok(source.includes("' Rethink it, or ask the user what they want.'") && source.includes('Adjust your work to match. Do not log these again.'))
})

test('rules tell agents to follow prior corrections', () => {
  assert.ok(rulesText([NPM_RULE]).includes('In earlier work on this project the user corrected these assumptions. Follow each rule, and do not make the original assumption again.'))
})

// --- The rest of the pure logic (judge, takeFeedback, clear, y/n, band, retention) ---

test('markSent and takeFeedback: every reviewed verdict of THIS session is told, nobody else\'s', () => {
  assert.deepEqual(markSent([a(1, 'open'), a(2, 'right')]).map((x) => x.isSent), [false, true])
  const items = [
    { ...a(1, 'wrong', false, 'use pnpm'), sessionKey: 'claude__s1' },
    { ...a(2, 'right'), sessionKey: 'codex__s2' },
    { ...a(3, 'open'), sessionKey: 'claude__s1' },
    { ...a(4, 'right'), sessionKey: null },
  ]
  const mine = takeFeedback(items, 'claude__s1')
  assert.match(mine.text, /#1 "guess 1": WRONG\. The user says: use pnpm/)
  assert.ok(!mine.text.includes('#2') && !mine.text.includes('#4'))
  assert.deepEqual(mine.items.map((x) => x.isSent), [true, false, false, false])
  assert.equal(takeFeedback(mine.items, 'claude__s1').text, null)
  // Unknown-session items go to unknown callers only.
  assert.match(takeFeedback(items, null).text, /#4 "guess 4": correct\./)
  assert.equal(takeFeedback(items, 'grok__s3').text, null)
})

test('judge transitions: a new verdict is unsent; wrong+correction upserts a rule, right drops it', () => {
  const items = [{ ...a(1, 'wrong', true, 'old note') }, a(2, 'open')]
  const wrong = setVerdict(items, 1, 'wrong', 'use pnpm', 9)
  assert.deepEqual(wrong.item, { id: 1, text: 'guess 1', verdict: 'wrong', isSent: false, note: 'use pnpm', reviewedAt: 9 })
  assert.equal(items[0].note, 'old note', 'input untouched')
  const right = setVerdict(wrong.items, 1, 'right', undefined, 10)
  assert.equal('note' in right.item, false)
  assert.equal(setVerdict(items, 99, 'right', undefined, 1).item, null)
  const rules = ruleEffect([], 'guess 1', 'wrong', 'use pnpm', { by: 'user', at: 9 })
  assert.deepEqual(rules, [{ id: 1, assumption: 'guess 1', correction: 'use pnpm', by: 'user', at: 9 }])
  assert.deepEqual(ruleEffect(rules, 'guess 1', 'wrong', '', {}), rules)
  assert.deepEqual(ruleEffect(rules, 'guess 1', 'right'), [])
  assert.deepEqual(ruleEffect(rules, 'guess 2', 'right'), rules)
})

test('clear reviewed keeps open items and unsent verdicts; y/n pick the newest open item; band label', () => {
  const items = [a(1, 'right', true), a(2, 'wrong', false), a(3, 'open'), a(4, 'right', true), a(5, 'open'), a(6, 'wrong', true)]
  assert.deepEqual(clearReviewed(items).map((x) => x.id), [2, 3, 5])
  assert.equal(newestOpen(items).id, 5)
  assert.equal(newestOpen([a(1, 'right')]), null)
  assert.equal(bandLabel([], 0), null)
  assert.equal(bandLabel([], 2), '◆ 2 project rules')
  assert.equal(bandLabel([a(1, 'open'), a(2, 'right')], 0), '◆ 1 assumption to review (2 total)')
  assert.equal(bandLabel([a(1, 'right'), a(2, 'wrong')], 1), '◆ All 2 assumptions reviewed')
})

test('retention: delivered verdicts expire after 14 days and the queue keeps at most 300 items', () => {
  const now = 100 * 24 * 3_600_000
  const old = now - KEEP_REVIEWED_MS - 1
  const items = [
    { id: 1, text: 'a', verdict: 'right', isSent: true, at: old, reviewedAt: old },
    { id: 2, text: 'b', verdict: 'wrong', isSent: false, at: old, reviewedAt: old },
    { id: 3, text: 'c', verdict: 'open', isSent: false, at: old },
    { id: 4, text: 'd', verdict: 'right', isSent: true, at: old, reviewedAt: now - 1000 },
  ]
  assert.deepEqual(prune(items, now).map((x) => x.id), [2, 3, 4])
  const many = Array.from({ length: MAX_ITEMS + 5 }, (_, i) => ({ id: i + 1, text: `t${i}`, verdict: i % 50 === 0 ? 'right' : 'open', isSent: i % 50 === 0, at: now, reviewedAt: now }))
  const kept = prune(many, now)
  assert.equal(kept.length, MAX_ITEMS)
  // Delivered verdicts go first (the five oldest of them), not the oldest open items.
  for (const id of [1, 51, 101, 151, 201]) assert.ok(!kept.some((x) => x.id === id), `dropped #${id}`)
  assert.ok(kept.some((x) => x.id === 2) && kept.some((x) => x.id === 251))
})

test('injected rules stay inside their budget, newest first kept, with a pointer to the full list', () => {
  const rules = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, assumption: `assumption number ${i + 1} ${'x'.repeat(60)}`, correction: `correction ${i + 1}` }))
  const text = injectedRules(rules)
  assert.ok(text.length <= RULES_BUDGET, `${text.length} chars`)
  assert.ok(text.includes('- correction 60 (not:'))
  assert.ok(!text.includes('- correction 1 (not:'))
  assert.match(text, /older rules not shown here: the agent-mods `assumptions` tool, action "rules", lists every rule\./)
  assert.equal(injectedRules(rules.slice(0, 2)), rulesText(rules.slice(0, 2)))
  assert.equal(injectedRules([]), null)
})

// --- The original's integration contracts, through the hooks, MCP and the CLI ---

test('a correction becomes a stored project rule in every later session start, and can be deleted', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('shop')
  assert.equal(textOf(await logAs(env, 'claude', cwd, 'uses npm')), 'Logged as assumption #1. Keep working; the user may correct it.')
  const wrong = await cli(env, cwd, 'assumptions', 'wrong', '1', '--fix', 'use pnpm')
  assert.equal(wrong.code, 0, wrong.err)
  assert.match(wrong.out, /^#1 "uses npm" marked wrong: use pnpm\.\nRule #1 added: use pnpm \(not: "uses npm"\)\n/)
  const [rule] = docOf(store, cwd).rules
  assert.deepEqual({ id: rule.id, assumption: rule.assumption, correction: rule.correction, by: rule.by }, { ...NPM_RULE, by: 'user' })
  assert.ok(Number.isFinite(rule.at))
  assert.equal(contextOf(await hook('codex', 'SessionStart', {}, on(cwd, env))), `${GUIDANCE}\n\n${rulesText([NPM_RULE])}`)
  assert.match((await cli(env, cwd, 'assumptions', 'list')).out, /^shop: 1 assumption · 1 wrong · 1 rule\n/)

  const deleted = await cli(env, cwd, 'rules', 'delete', '1')
  assert.equal(deleted.code, 0, deleted.err)
  assert.match(deleted.out, /^Rule #1 deleted: use pnpm \(not: "uses npm"\)\. 0 rules left\./)
  assert.deepEqual(docOf(store, cwd).rules, [])
  assert.equal(contextOf(await hook('codex', 'SessionStart', {}, on(cwd, env))), GUIDANCE)
  assert.match((await cli(env, cwd, 'assumptions', 'list')).out, /^shop: 1 assumption · 1 wrong · 0 rules\n/)
})

test('marking wrong with no correction makes no rule', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('shop')
  await logAs(env, 'claude', cwd, 'uses npm')
  const wrong = await cli(env, cwd, 'assumptions', 'wrong', '1')
  assert.match(wrong.out, /^#1 "uses npm" marked wrong\.\nNo rule made: no correction given\.\n/)
  assert.deepEqual(docOf(store, cwd).rules, [])
  assert.equal(contextOf(await hook('claude', 'SessionStart', {}, on(cwd, env))), GUIDANCE)
  assert.match((await cli(env, cwd, 'assumptions', 'list', '--all')).out, /1 assumption · 1 wrong · 0 rules/)
})

test('marking the assumption right after all drops its rule', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('shop')
  await logAs(env, 'claude', cwd, 'uses npm')
  await cli(env, cwd, 'assumptions', 'wrong', '1', '--fix', 'use pnpm')
  const right = await cli(env, cwd, 'assumptions', 'right', '1')
  assert.match(right.out, /^#1 "uses npm" marked right\.\nRule #1 removed\.\n/)
  assert.deepEqual(docOf(store, cwd).rules, [])
  assert.equal(contextOf(await hook('devin', 'SessionStart', {}, on(cwd, env))), GUIDANCE)
})

test('rules are per repo: another repo gets none, a second worktree of the same repo shares them', async () => {
  const { env } = tempStore()
  const main = makeRepo('shop')
  const worktree = makeWorktree(main, 'feature')
  const other = makeRepo('other')
  await logAs(env, 'claude', main, 'uses npm')
  await cli(env, main, 'assumptions', 'wrong', '1', '--fix', 'use pnpm')
  for (const agent of ['claude', 'codex', 'devin']) {
    assert.equal(contextOf(await hook(agent, 'SessionStart', {}, on(worktree, env))), `${GUIDANCE}\n\n${rulesText([NPM_RULE])}`, agent)
    assert.equal(contextOf(await hook(agent, 'SessionStart', {}, on(other, env, { sessionId: `other-${agent}` }))), GUIDANCE, agent)
  }
  assert.match((await cli(env, worktree, 'assumptions', 'list', '--all')).out, /^shop: 1 assumption · 1 wrong · 1 rule\n/)
  assert.match((await cli(env, other, 'assumptions')).out, /^other: 0 assumptions · 0 wrong · 0 rules\n\nNo assumptions yet\./)
})

test('Windows: every spelling of one repo path reaches the same queue and rules', { skip: process.platform !== 'win32' }, async () => {
  const { env } = tempStore()
  const repo = makeRepo('Projects')
  const upper = repo.toUpperCase()
  const slashed = repo.replace(/\\/g, '/').replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
  const msys = `/${repo[0].toLowerCase()}${repo.slice(2).replace(/\\/g, '/')}`
  await logAs(env, 'codex', upper, 'uses npm')
  assert.equal((await cli(env, slashed, 'assumptions', 'wrong', '1', '--fix', 'use pnpm')).code, 0)
  assert.equal(contextOf(await hook('claude', 'SessionStart', {}, on(msys, env))), `${GUIDANCE}\n\n${rulesText([NPM_RULE])}`)
  assert.deepEqual((await hook('codex', 'Stop', {}, on(`\\\\?\\${repo}`, env))).json, { decision: 'block', reason: FEEDBACK_WRONG })
})

// --- Every agent's hook shape ---

test('SessionStart: Claude, Codex and Devin get the guidance and rules at once; Grok with its next PostToolUse', async () => {
  const { env } = tempStore()
  const cwd = makeRepo('start')
  await logAs(env, 'codex', cwd, 'uses npm')
  await cli(env, cwd, 'assumptions', 'wrong', '1', '--fix', 'use pnpm')
  const expected = `${GUIDANCE}\n\n${rulesText([NPM_RULE])}`
  for (const agent of ['claude', 'codex', 'devin']) {
    assert.equal(contextOf(await hook(agent, 'SessionStart', {}, on(cwd, env))), expected, agent)
  }
  assert.equal((await hook('grok', 'SessionStart', {}, on(cwd, env))).raw, '')
  assert.equal(contextOf(await hook('grok', 'PostToolUse', edit(cwd), on(cwd, env))), expected)
  assert.equal((await hook('grok', 'PostToolUse', edit(cwd), on(cwd, env))).raw, '')
})

test('Stop blocks once on an unsent wrong verdict in every agent, never with stop_hook_active, never for another session', async () => {
  for (const agent of AGENTS) {
    const { env, store } = tempStore()
    const cwd = makeRepo(`stop-${agent}`)
    await logAs(env, agent, cwd, 'uses npm')
    await cli(env, cwd, 'assumptions', 'wrong', '1', '--fix', 'use pnpm')
    assert.equal((await hook(agent, 'Stop', {}, on(cwd, env, { sessionId: 'someone-else' }))).raw, '', `${agent} other session`)
    assert.equal((await hook(agent, 'Stop', { stopHookActive: true }, on(cwd, env))).raw, '', `${agent} guard`)
    assert.equal(docOf(store, cwd).items[0].isSent, false, `${agent} guard leaves it unsent`)
    const first = await hook(agent, 'Stop', {}, on(cwd, env))
    assert.deepEqual(first.json, { decision: 'block', reason: FEEDBACK_WRONG }, agent)
    assert.equal(docOf(store, cwd).items[0].isSent, true, `${agent} marked sent before blocking`)
    assert.equal((await hook(agent, 'Stop', {}, on(cwd, env))).raw, '', `${agent} blocks once`)
  }
})

test('Stop: a right verdict alone does not hold the turn; it goes with the next prompt', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('stop-right')
  await hook('claude', 'SessionStart', {}, on(cwd, env))
  await logAs(env, 'claude', cwd, 'uses npm')
  await cli(env, cwd, 'assumptions', 'right', '1')
  assert.equal((await hook('claude', 'Stop', {}, on(cwd, env))).raw, '')
  assert.equal(docOf(store, cwd).items[0].isSent, false)
  assert.equal(contextOf(await hook('claude', 'UserPromptSubmit', { prompt: 'next' }, on(cwd, env))), FEEDBACK_RIGHT)
})

test('UserPromptSubmit delivers due verdicts to the session that logged them (Claude, Codex, Devin)', async () => {
  for (const agent of ['claude', 'codex', 'devin']) {
    const { env, store } = tempStore()
    const cwd = makeRepo(`ups-${agent}`)
    await hook(agent, 'SessionStart', {}, on(cwd, env))
    await hook(agent, 'SessionStart', {}, on(cwd, env, { sessionId: 'someone-else' }))
    await logAs(env, agent, cwd, 'uses npm')
    await cli(env, cwd, 'assumptions', 'right', '1')
    assert.equal((await hook(agent, 'UserPromptSubmit', { prompt: 'hi' }, on(cwd, env, { sessionId: 'someone-else' }))).raw, '', agent)
    assert.equal(contextOf(await hook(agent, 'UserPromptSubmit', { prompt: 'next' }, on(cwd, env))), FEEDBACK_RIGHT, agent)
    assert.equal(docOf(store, cwd).items[0].isSent, true, agent)
    assert.equal((await hook(agent, 'UserPromptSubmit', { prompt: 'more' }, on(cwd, env))).raw, '', agent)
  }
})

test('Grok: UserPromptSubmit leaves verdicts unsent (it cannot take context there); PostToolUse delivers them', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('ups-grok')
  await hook('grok', 'SessionStart', {}, on(cwd, env))
  await logAs(env, 'grok', cwd, 'uses npm')
  await cli(env, cwd, 'assumptions', 'wrong', '1', '--fix', 'use pnpm')
  assert.equal((await hook('grok', 'UserPromptSubmit', { prompt: 'next' }, on(cwd, env))).raw, '')
  assert.equal(docOf(store, cwd).items[0].isSent, false, 'still unsent, so Stop could still hold the turn')
  const ctx = contextOf(await hook('grok', 'PostToolUse', edit(cwd), on(cwd, env)))
  assert.ok(ctx.startsWith(GUIDANCE), 'the queued SessionStart briefing comes first')
  assert.ok(ctx.includes('- use pnpm (not: "uses npm")\nThis list replaces the project rules'), 'the rule made since start, queued at the prompt')
  assert.ok(ctx.endsWith(FEEDBACK_WRONG))
  assert.equal(docOf(store, cwd).items[0].isSent, true)
  assert.equal((await hook('grok', 'Stop', {}, on(cwd, env))).raw, '')
})

test('UserPromptSubmit sends changed project rules once, and says when they were removed', async () => {
  const { env } = tempStore()
  const cwd = makeRepo('sig')
  await hook('claude', 'SessionStart', {}, on(cwd, env))
  assert.equal((await hook('claude', 'UserPromptSubmit', { prompt: 'a' }, on(cwd, env))).raw, '')
  await logAs(env, 'codex', cwd, 'uses npm')
  await cli(env, cwd, 'assumptions', 'wrong', '1', '--fix', 'use pnpm')
  assert.equal(
    contextOf(await hook('claude', 'UserPromptSubmit', { prompt: 'b' }, on(cwd, env))),
    `${rulesText([NPM_RULE])}\nThis list replaces the project rules you were given earlier in this session.`,
  )
  assert.equal((await hook('claude', 'UserPromptSubmit', { prompt: 'c' }, on(cwd, env))).raw, '')
  await cli(env, cwd, 'rules', 'delete', '1')
  assert.equal(
    contextOf(await hook('claude', 'UserPromptSubmit', { prompt: 'd' }, on(cwd, env))),
    '# Project rules learned from corrected assumptions\nThe user removed the project rules you were given earlier in this session. They no longer apply.',
  )
})

test('a session this mod never saw start gets the briefing with its first prompt', async () => {
  const { env } = tempStore()
  const cwd = makeRepo('late')
  await logAs(env, 'claude', cwd, 'uses npm')
  await cli(env, cwd, 'assumptions', 'wrong', '1', '--fix', 'use pnpm')
  assert.equal(contextOf(await hook('devin', 'UserPromptSubmit', { prompt: 'hi' }, on(cwd, env))), `${GUIDANCE}\n\n${rulesText([NPM_RULE])}`)
  assert.equal((await hook('devin', 'UserPromptSubmit', { prompt: 'again' }, on(cwd, env))).raw, '')
})

test('PostToolUse hands over due verdicts mid-turn in every agent, once; subagent events are skipped', async () => {
  for (const agent of AGENTS) {
    const { env, store } = tempStore()
    const cwd = makeRepo(`post-${agent}`)
    await logAs(env, agent, cwd, 'uses npm')
    await cli(env, cwd, 'assumptions', 'right', '1')
    assert.equal((await hook(agent, 'PostToolUse', { ...edit(cwd), isSubagent: true }, on(cwd, env))).raw, '', `${agent} subagent`)
    assert.equal(docOf(store, cwd).items[0].isSent, false, agent)
    assert.equal(contextOf(await hook(agent, 'PostToolUse', edit(cwd), on(cwd, env))), FEEDBACK_RIGHT, agent)
    assert.equal((await hook(agent, 'PostToolUse', { tool: 'todo', todos: [{ text: 'x', status: 'pending' }] }, on(cwd, env))).raw, '', agent)
  }
})

// --- MCP tools ---

test('log_assumption: text required, context kept, text clipped to one line of 500, caller recorded, ids never reused', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('mcp')
  await withClient(env, 'codex', async (client) => {
    const blank = await client.tool('log_assumption', { assumption: '   ', cwd })
    assert.equal(blank.isError, true)
    assert.equal(textOf(blank), 'assumption is required')
    const one = await client.tool('log_assumption', { assumption: ' uses npm ', context: 'installing deps', cwd, session_id: SESSION_IDS.codex })
    assert.equal(textOf(one), 'Logged as assumption #1. Keep working; the user may correct it.')
    assert.equal(one.data.id, 1)
    const two = await client.tool('log_assumption', { assumption: `line one\n\u0007line two ${'y'.repeat(800)}`, cwd })
    assert.equal(two.data.id, 2)
  })
  const [first, second] = docOf(store, cwd).items
  const { at, ...rest } = first
  assert.deepEqual(rest, { id: 1, text: 'uses npm', context: 'installing deps', verdict: 'open', isSent: false, agent: 'codex', sessionKey: sessionKey('codex', SESSION_IDS.codex) })
  assert.ok(Number.isFinite(at))
  assert.equal(second.text.length, 500)
  assert.ok(second.text.startsWith('line one line two yyy'))
  assert.equal(second.sessionKey, null, 'no session id and no live record: unknown session')
  assert.equal(second.agent, 'codex')

  // Ids never repeat, even after clearing empties the list.
  await cli(env, cwd, 'assumptions', 'right', '1')
  await cli(env, cwd, 'assumptions', 'right', '2')
  await withClient(env, 'codex', async (client) => {
    assert.match(textOf(await client.tool('assumptions', { action: 'feedback', cwd, session_id: SESSION_IDS.codex })), /#1 "uses npm": correct\./)
    assert.match(textOf(await client.tool('assumptions', { action: 'feedback', cwd })), /#2 "line one/)
    assert.match(textOf(await client.tool('assumptions', { action: 'clear_reviewed', cwd })), /^Cleared 2 reviewed assumptions\./)
    assert.deepEqual(docOf(store, cwd).items, [])
    assert.equal((await client.tool('log_assumption', { assumption: 'next', cwd })).data.id, 3)
  })
})

test('log_assumption hands the caller its own due verdicts and marks them sent', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('mcp-due')
  await logAs(env, 'claude', cwd, 'uses npm')
  await cli(env, cwd, 'assumptions', 'wrong', '1', '--fix', 'use pnpm')
  assert.equal(textOf(await logAs(env, 'codex', cwd, 'REST API')), 'Logged as assumption #2. Keep working; the user may correct it.')
  assert.equal(docOf(store, cwd).items[0].isSent, false)
  assert.equal(textOf(await logAs(env, 'claude', cwd, 'tabs')), `Logged as assumption #3. Keep working; the user may correct it.\n\n${FEEDBACK_WRONG}`)
  assert.equal(docOf(store, cwd).items[0].isSent, true)
})

test('log_assumption without cwd files the item under the caller session\'s own project', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('routed')
  const elsewhere = makeRepo('elsewhere')
  const key = sessionKey('claude', SESSION_IDS.claude)
  store.writeJson(`sessions/${key}.json`, { v: 1, agent: 'claude', id: SESSION_IDS.claude, key, cwd, beatAt: Date.now() })
  const client = mcpClient({ mods: MODS, env: { ...env, CLAUDE_PROJECT_DIR: elsewhere }, clientName: 'claude-code' })
  await client.init()
  const result = await client.tool('log_assumption', { assumption: 'uses npm', session_id: SESSION_IDS.claude })
  client.close()
  assert.equal(result.data.project, 'routed')
  assert.equal(docOf(store, cwd).items[0].sessionKey, key)
  assert.equal(docOf(store, elsewhere), null)
})

test('log_assumption is off when the mod is switched off in config', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('off')
  store.writeJson('config.json', { mods: { assumptions: false } })
  assert.match(textOf(await logAs(env, 'claude', cwd, 'uses npm')), /^Assumption tracking is off/)
  assert.equal(docOf(store, cwd), null)
})

test('assumptions review: judge semantics with provenance; your own verdict comes back at once', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('review')
  await logAs(env, 'claude', cwd, 'uses npm')
  await logAs(env, 'codex', cwd, 'REST API')
  const codexKey = sessionKey('codex', SESSION_IDS.codex)
  await withClient(env, 'codex', async (client) => {
    const as = (args) => client.tool('assumptions', { cwd, session_id: SESSION_IDS.codex, ...args })
    const wrong = await as({ action: 'review', id: 1, verdict: 'wrong', correction: 'use pnpm' })
    assert.equal(
      textOf(wrong),
      '#1 "uses npm" marked wrong: use pnpm.\nRule #1 added: use pnpm (not: "uses npm")\nIt reaches Claude Code 11111111 with its next prompt or edit, or when it tries to stop.',
    )
    assert.deepEqual(docOf(store, cwd).rules[0].by, { agent: 'codex', sessionKey: codexKey })
    assert.equal(docOf(store, cwd).items[0].isSent, false, "Claude's verdict waits for Claude")

    const own = await as({ action: 'review', id: 2, verdict: 'right' })
    assert.equal(textOf(own), `#2 "REST API" marked right.\n\n[assumption-tracker] The user reviewed your assumptions:\n- #2 "REST API": correct.\nAdjust your work to match. Do not log these again.`)
    assert.equal(docOf(store, cwd).items[1].isSent, true)

    const again = await as({ action: 'review', id: 1, verdict: 'wrong', correction: 'use bun' })
    assert.match(textOf(again), /^#1 "uses npm" marked wrong: use bun\.\nRule #1 updated: use bun \(not: "uses npm"\)\n/)
    assert.match(textOf(await as({ action: 'review', id: 1, verdict: 'right' })), /^#1 "uses npm" marked right\.\nRule #1 removed\.\n/)
    assert.deepEqual(docOf(store, cwd).rules, [])

    assert.equal((await as({ action: 'review', verdict: 'right' })).isError, true)
    assert.equal((await as({ action: 'review', id: 1, verdict: 'maybe' })).isError, true)
    assert.equal(textOf(await as({ action: 'review', id: 42, verdict: 'right' })), 'No assumption #42 in review.')
    assert.equal((await as({ action: 'bogus' })).isError, true)
  })
  // Claude's session gets the latest verdict on #1 with its next prompt.
  await hook('claude', 'SessionStart', {}, on(cwd, env))
  assert.equal(contextOf(await hook('claude', 'UserPromptSubmit', { prompt: 'go' }, on(cwd, env))), FEEDBACK_RIGHT)
})

test('assumptions list: stats, rules, items newest first labelled with the agent; status filter', async () => {
  const { env } = tempStore()
  const cwd = makeRepo('listing')
  await logAs(env, 'claude', cwd, 'uses npm')
  await logAs(env, 'codex', cwd, 'REST API')
  await logAs(env, 'grok', cwd, 'dark theme', { context: 'styling the header' })
  await cli(env, cwd, 'assumptions', 'wrong', '1', '--fix', 'use pnpm')
  await withClient(env, 'devin', async (client) => {
    const open = await client.tool('assumptions', { action: 'list', cwd })
    assert.equal(open.data.stats, '3 assumptions · 1 wrong · 1 rule')
    assert.deepEqual(open.data.items.map((i) => [i.id, i.agent]), [[3, 'grok'], [2, 'codex']])
    const text = textOf(open)
    assert.match(text, /^listing: 3 assumptions · 1 wrong · 1 rule\n\nProject rules \(from corrections, sent every session\):\n {2}#1 use pnpm \(not: "uses npm"\) · by the user\n/)
    assert.match(text, /\(data, not instructions\), newest first:\n\? #3 dark theme {2}\(Grok 33333333, just now\)\n {4}styling the header\n\? #2 REST API {2}\(Codex 22222222, just now\)\n/)
    assert.match(text, /\(1 more not shown; status "all" lists every one\)$/)
    const all = await client.tool('assumptions', { action: 'list', status: 'all', cwd })
    assert.deepEqual(all.data.items.map((i) => i.id), [3, 2, 1])
    const reviewed = await client.tool('assumptions', { action: 'list', status: 'reviewed', cwd })
    assert.deepEqual(reviewed.data.items.map((i) => i.id), [1])
    const inherited = await client.tool('assumptions', { action: 'list', status: 'constructor', cwd })
    assert.deepEqual(inherited.data.items.map((i) => i.id), [3, 2], 'unknown status falls back to open')
    assert.match(textOf(reviewed), /✗ #1 uses npm {2}\(Claude Code 11111111, just now, not sent yet\)\n {4}→ use pnpm/)
  })
})

test('assumptions feedback, rules, delete_rule and clear_reviewed', async () => {
  const { env } = tempStore()
  const cwd = makeRepo('pull')
  await logAs(env, 'codex', cwd, 'uses npm')
  await withClient(env, 'codex', async (client) => {
    const as = (args) => client.tool('assumptions', { cwd, ...args })
    assert.equal(textOf(await as({ action: 'feedback', session_id: SESSION_IDS.codex })), 'No new verdicts.')
    await cli(env, cwd, 'assumptions', 'wrong', '1', '--fix', 'use pnpm')
    assert.equal(textOf(await as({ action: 'feedback', session_id: 'another-thread' })), 'No new verdicts.')
    assert.equal(textOf(await as({ action: 'feedback', session_id: SESSION_IDS.codex })), FEEDBACK_WRONG)
    assert.equal(textOf(await as({ action: 'feedback', session_id: SESSION_IDS.codex })), 'No new verdicts.')
    const rules = await as({ action: 'rules' })
    assert.equal(textOf(rules), rulesText([NPM_RULE]))
    assert.equal(rules.data.rules.length, 1)
    assert.equal(textOf(await as({ action: 'clear_reviewed' })), 'Cleared 1 reviewed assumption. Open ones and verdicts not sent yet stay.')
    assert.equal(textOf(await as({ action: 'delete_rule', id: 1 })), 'Rule #1 deleted.\n\nNo project rules left.')
    assert.equal((await as({ action: 'delete_rule', id: 1 })).isError, true)
    assert.equal((await as({ action: 'delete_rule' })).isError, true)
    assert.equal(textOf(await as({ action: 'rules' })), 'No project rules in pull.')
  })
})

test('tool schemas stay small and named for every agent', () => {
  assert.deepEqual(assumptions.tools.map((t) => t.name), ['log_assumption', 'assumptions'])
  const bytes = JSON.stringify(assumptions.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))).length
  assert.ok(bytes < 3000, `${bytes} bytes`)
  for (const t of assumptions.tools) assert.ok(/^[a-z][a-z0-9_]*$/.test(t.name) && t.description.length < 1200)
})

// --- CLI ---

test('CLI: y / n answer the newest open assumption; status; list --json; rules list', async () => {
  const { env } = tempStore()
  const cwd = makeRepo('cli')
  assert.equal((await cli(env, cwd, 'assumptions', 'status')).out, '')
  await logAs(env, 'claude', cwd, 'uses npm')
  await logAs(env, 'claude', cwd, 'REST API')
  assert.equal((await cli(env, cwd, 'assumptions', 'status')).out, '◆ 2 assumptions to review (2 total)\n')
  const list = await cli(env, cwd, 'assumptions')
  assert.match(list.out, /Assumptions, newest first:\n\? #2 REST API {2}\(Claude Code 11111111, just now\)\n\? #1 uses npm/)
  assert.match(list.out, /Mark them: agent-mods assumptions right <id>/)
  assert.match((await cli(env, cwd, 'assumptions', 'n', '--fix', 'GraphQL')).out, /^#2 "REST API" marked wrong: GraphQL\.\nRule #1 added: GraphQL \(not: "REST API"\)\n/)
  assert.match((await cli(env, cwd, 'assumptions', 'y')).out, /^#1 "uses npm" marked right\.\nIt reaches Claude Code 11111111 with its next prompt or edit\.\n$/)
  const none = await cli(env, cwd, 'assumptions', 'y')
  assert.equal(none.code, 1)
  assert.equal(none.err, 'No open assumptions in cli.\n')
  assert.equal((await cli(env, cwd, 'assumptions', 'status')).out, '◆ All 2 assumptions reviewed\n')
  assert.match((await cli(env, cwd, 'assumptions', 'list')).out, /No open assumptions\.\n\(2 more not shown; --all lists every one\)/)
  const json = JSON.parse((await cli(env, cwd, 'assumptions', 'list', '--all', '--json')).out)
  assert.deepEqual(json.items.map((i) => [i.id, i.verdict, i.note ?? null]), [[2, 'wrong', 'GraphQL'], [1, 'right', null]])
  assert.equal(json.rules[0].by, 'user')
  assert.equal(JSON.parse((await cli(env, cwd, 'assumptions', 'status', '--json')).out).rules, 1)
  assert.equal((await cli(env, cwd, 'rules')).out, 'Project rules in cli (from corrections, sent every session):\n  #1 GraphQL (not: "REST API") · by the user\n')
  assert.deepEqual(JSON.parse((await cli(env, cwd, 'rules', 'list', '--json')).out).map((r) => r.id), [1])
  assert.equal((await cli(env, cwd, 'assumptions', 'clear')).out, 'Cleared 0 reviewed assumptions. Open ones and verdicts not sent yet stay.\n')
})

test('CLI: says where a verdict goes, and rejects bad input', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('cli-errors')
  await logAs(env, 'codex', cwd, 'uses npm')
  await withClient(env, 'codex', (client) => client.tool('log_assumption', { assumption: 'no session', cwd }))
  const key = sessionKey('codex', SESSION_IDS.codex)
  store.writeJson(`sessions/${key}.json`, { v: 1, agent: 'codex', id: SESSION_IDS.codex, key, endedAt: Date.now() })
  assert.match((await cli(env, cwd, 'assumptions', 'right', '1')).out, /Codex 22222222 has ended, so this verdict will not reach it\./)
  assert.match((await cli(env, cwd, 'assumptions', 'right', '#2')).out, /No session is linked to it/)
  for (const argv of [['assumptions', 'wrong'], ['assumptions', 'wrong', '1', '--fix'], ['assumptions', 'bogus'], ['rules', 'delete'], ['rules', 'nope']]) {
    const r = await cli(env, cwd, ...argv)
    assert.equal(r.code, 2, argv.join(' '))
    assert.ok(r.err.length > 0)
  }
  assert.equal((await cli(env, cwd, 'assumptions', 'right', '9')).code, 1)
  assert.equal((await cli(env, cwd, 'rules', 'delete', '9')).code, 1)
  const help = await cli(env, cwd, 'assumptions', '--help')
  assert.match(help.out, /^Usage: agent-mods assumptions/)
})

test('skill: frontmatter the four agents accept, and a CLI fallback', () => {
  const text = fs.readFileSync(path.join(ROOT, 'skills', 'assumptions', 'SKILL.md'), 'utf8')
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)[1]
  assert.equal(/^name:\s*(.+)$/m.exec(fm)[1].trim(), 'assumptions')
  const description = /^description:\s*(.+)$/m.exec(fm)[1].trim()
  assert.ok(description.length > 20 && description.length <= 1024)
  assert.ok(!/[<>]/.test(description))
  assert.match(text, /agent-mods assumptions/)
  assert.match(text, /Never judge an assumption yourself/)
})
