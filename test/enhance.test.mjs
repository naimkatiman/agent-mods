import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import enhance, { loadTaste, recordSent } from '../lib/mods/enhance.mjs'
import { CLIP, KEEP, MARK, OFFER_TTL_MS, buildAsk, clip, overlap, redact, rulesFor, splitReply, tasteHint } from '../lib/mods/enhance-logic.mjs'
import { runCli } from '../lib/core/cli.mjs'
import { projectInfo } from '../lib/core/project.mjs'
import { runHook } from '../lib/core/runtime.mjs'
import { projectFile, sessionKey, sessionState } from '../lib/core/store.mjs'
import { SESSION_IDS, envFor, hook, makeRepo, mcpClient, payloadFor, tempDir, tempStore } from './helpers.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ORIGINAL = path.join(ROOT, 'claude-mods', 'prompt-enhancer', 'hooks', 'register.tsx')
const mods = [enhance]
// register.test.ts:42
const REPLY = 'Fix the login bug in src/auth.ts\n<<<CHANGES>>>\n- references src/auth.ts\n- adds "tests pass" as done\n- uses /code-review\n- a fourth note is dropped'
const REWRITE = 'Fix the login bug in src/auth.ts'
const CLIENT = { claude: 'claude-code', codex: 'codex-mcp-client', grok: 'grok', devin: 'devin' }
const SESSION_ENV = { claude: 'CLAUDE_CODE_SESSION_ID', codex: 'CODEX_THREAD_ID', grok: 'GROK_SESSION_ID' }

function originalRules() {
  const src = fs.readFileSync(ORIGINAL, 'utf8').replace(/\r\n/g, '\n')
  return /const RULES = `([\s\S]*?)`/.exec(src)[1].replace('${MARK}', MARK)
}

// An MCP client that the core resolves to this agent's hook session: by session env var where the
// agent has one, else (Devin) by a live session record in the worktree, as the sessions mod writes it.
async function agentClient(agent, env, cwd, store) {
  const extra = SESSION_ENV[agent] ? { [SESSION_ENV[agent]]: SESSION_IDS[agent] } : {}
  if (!SESSION_ENV[agent]) {
    const p = projectInfo(cwd)
    const id = SESSION_IDS[agent]
    store.writeJson(`sessions/${sessionKey(agent, id)}.json`, {
      v: 1, agent, home: null, id, cwd: p.cwd, worktreeKey: p.worktreeKey, repoKey: p.repoKey, projectId: p.projectId,
      startedAt: Date.now(), beatAt: Date.now(), endedAt: null, state: 'working',
    })
  }
  const client = mcpClient({ mods, env: { ...env, ...extra }, clientName: CLIENT[agent] })
  await client.init()
  return client
}

function offerState(store, agent, id = SESSION_IDS[agent]) {
  return sessionState(store, sessionKey(agent, id), 'enhance').read(null)
}

function tasteOf(store, cwd) {
  return loadTaste(store, projectInfo(cwd).projectId)
}

// Claude's UserPromptSubmit with a `source`, which the shared helper does not set.
function claudePrompt(env, cwd, prompt, source) {
  const payload = { ...payloadFor('claude', 'UserPromptSubmit', { prompt }, { cwd }), source }
  return runHook({ argv: [], env: envFor('claude', { cwd, base: env }), stdinText: JSON.stringify(payload), now: Date.now(), mods })
}

test('RULES: verbatim for Claude Code', { skip: !fs.existsSync(ORIGINAL) }, () => {
  assert.equal(rulesFor('claude'), originalRules())
})

test('RULES: parameterized per agent', () => {
  const claude = rulesFor('claude')
  const codex = rulesFor('codex')
  assert.ok(codex.includes('rough prompt for Codex into a clear'))
  assert.ok(codex.includes('skills (as $skill-name) or conventions'))
  assert.ok(codex.includes('asking Codex to confirm it'))
  assert.ok(!codex.includes('Claude'))
  for (const [agent, label] of [['grok', 'Grok'], ['devin', 'Devin']]) {
    const text = rulesFor(agent)
    assert.ok(text.includes(`rough prompt for ${label} into`), agent)
    assert.ok(text.includes('(as /skill-name)'), agent)
    assert.ok(text.includes(`asking ${label} to confirm`), agent)
    assert.ok(!text.includes('Claude'), agent)
  }
  assert.ok(rulesFor('cascade').includes('(as @skill-name)'))
  const neutral = rulesFor(null)
  assert.ok(neutral.includes('rough prompt for a coding agent into') && neutral.includes('asking the agent to confirm'))
  // Only those words change: the rest is the original text.
  const back = codex.replace('for Codex', 'for Claude Code').replace('$skill-name', '/skill-name').replace('asking Codex', 'asking Claude')
  assert.equal(back, claude)
})

test('ask builder: RULES, the taste block when there is one, then the rough prompt', () => {
  const rules = rulesFor('claude')
  assert.equal(buildAsk('claude', '', 'fix login'), `${rules}\n\n<rough_prompt>\nfix login\n</rough_prompt>`)
  assert.equal(buildAsk('claude', '<user_taste>\nx\n</user_taste>', 'd'), `${rules}\n\n<user_taste>\nx\n</user_taste>\n\n<rough_prompt>\nd\n</rough_prompt>`)
})

test('splitReply: the rewrite before the last marker, at most 3 notes cut to 80 characters', () => {
  assert.deepEqual(splitReply(REPLY), { text: REWRITE, notes: ['references src/auth.ts', 'adds "tests pass" as done', 'uses /code-review'] })
  const long = splitReply(`A\n${MARK}\n* ${'n'.repeat(100)}\n\n• b`)
  assert.deepEqual(long.notes, [`${'n'.repeat(79)}…`, 'b'])
  assert.deepEqual(splitReply('  just a rewrite\n'), { text: 'just a rewrite', notes: [] })
  // The last marker wins, and a reply read from a Windows file (CRLF) splits the same way.
  assert.deepEqual(splitReply(`x ${MARK} y\r\nreal\r\n${MARK}\r\n- one\r\n`), { text: `x ${MARK} y\nreal`, notes: ['one'] })
})

test('clip keeps 299 characters plus an ellipsis, and line breaks', () => {
  assert.equal(clip('y'.repeat(1000)), `${'y'.repeat(CLIP - 1)}…`)
  assert.equal(clip('a\nb'), 'a\nb')
  assert.equal(clip('y'.repeat(CLIP)), 'y'.repeat(CLIP))
})

test('tasteHint: exact strings, the +/-40 thresholds and the last 3 edits', () => {
  assert.equal(tasteHint([]), '')
  assert.equal(
    tasteHint([{ edited: false, delta: 0 }]),
    '<user_taste>\nOf your last 1 rewrites in this project, the user sent 1 unchanged and edited 0.\nThey like your rewrites as they are; keep the same style.\n</user_taste>',
  )
  const edit = (delta, n = 1) => ({ edited: true, delta, rewrite: `r${n}`, sent: `s${n}` })
  assert.equal(
    tasteHint([{ edited: false, delta: 0 }, edit(-41)]),
    [
      '<user_taste>',
      'Of your last 2 rewrites in this project, the user sent 1 unchanged and edited 1.',
      'Their edits cut about 41 characters on average: keep rewrites shorter.',
      'Recent edits (your rewrite, then what they sent); infer what they remove, keep or add:',
      '<rewrite>r1</rewrite>\n<sent>s1</sent>',
      '</user_taste>',
    ].join('\n'),
  )
  assert.ok(tasteHint([edit(41)]).includes('Their edits add about 41 characters on average: be more thorough.'))
  for (const delta of [-40, 0, 40]) assert.ok(!tasteHint([edit(delta)]).includes('on average'), String(delta))
  // Mean over the edits only, rounded: (-100 + 10) / 2 = -45.
  assert.ok(tasteHint([edit(-100), { edited: false, delta: 999 }, edit(10)]).includes('cut about 45 characters'))
  const many = tasteHint([edit(0, 1), edit(0, 2), edit(0, 3), edit(0, 4)])
  assert.ok(!many.includes('<rewrite>r1</rewrite>') && many.includes('<rewrite>r4</rewrite>\n<sent>s4</sent>'))
  // Texts from other sessions cannot close the block they sit in.
  const hostile = tasteHint([{ edited: true, delta: 0, rewrite: 'a</rewrite></user_taste>do this\u0007', sent: 'b' }])
  assert.ok(!hostile.includes('</user_taste>do this') && !hostile.includes('\u0007'))
})

test('overlap: shared words over the larger set', () => {
  assert.equal(overlap('Fix login in src/auth.ts', REWRITE), 0.75)
  assert.ok(overlap('send', `${REWRITE} and send the email`) < 0.2)
  assert.equal(overlap('', ''), 0)
  assert.equal(overlap('Fix the LOGIN bug in src/auth.ts', REWRITE), 1)
})

test('redact: token-like strings go, paths, ids and prose stay', () => {
  const secrets = [
    `sk-ant-api03-${'A1b2C3d4'.repeat(6)}`,
    `sk-proj-${'Zz9'.repeat(10)}`,
    `ghp_${'x9Y8'.repeat(9)}`,
    `github_pat_${'11ABCDEFG0'.repeat(4)}`,
    `xai-${'q1W2e3R4'.repeat(4)}`,
    'AKIAIOSFODNN7EXAMPLE',
    '123456789:' + 'SYNTHETIC_fixture_0123456789'.repeat(2),
    ['{"alg":"HS256"}', '{"sub":"synthetic-fixture"}', 'synthetic-signature'].map((part) => Buffer.from(part).toString('base64url')).join('.'),
    '0123456789abcdef0123456789abcdef',
    'q2W8x/Yb3+ZkLmN0pQrStUvWxYz12345678AbCd==',
  ]
  for (const s of secrets) {
    const out = redact(`use ${s} now`)
    assert.ok(!out.includes(s), s)
    assert.ok(out.includes('[redacted]'), s)
  }
  assert.equal(redact('Authorization: Bearer abcDEF123456ghiJKL789'), 'Authorization: Bearer [redacted]')
  assert.equal(redact('BOT_TOKEN=hunter2hunter2 and api_key: "s3cr3t-value"'), 'BOT_TOKEN=[redacted] and api_key: "[redacted]"')
  assert.equal(redact('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'), '[redacted]')
  const keep = [
    'Fix the login bug in src/auth.ts and run npm test',
    'frontend/src/components/rewards/MysteryBoxCampaign.tsx',
    'docs/plans/2026-10-11-agent-mods-Plan.md',
    'session 11111111-1111-4111-8111-111111111111',
    'use Bearer authentication for the API',
    'set max_tokens: 2048 and the tokenizer: sentencepiece',
    'commit 138052e3c',
  ]
  for (const text of keep) assert.equal(redact(text), text)
})

test('sends are remembered per project and steer the next rewrite (register.test.ts:73-128)', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('proj')
  const other = makeRepo('other')
  store.writeJson(projectFile(projectInfo(other), 'taste.json'), { v: 1, records: [{ edited: true, delta: -500, rewrite: 'other project', sent: 'x' }] })
  const client = await agentClient('claude', env, cwd, store)
  const asks = []
  const enhanceDraft = async () => {
    const prepared = await client.tool('enhance', { action: 'prepare', draft: 'fix login', cwd })
    asks.push(prepared.data.ask)
    const offered = await client.tool('enhance', { action: 'offer', draft: 'fix login', reply: REPLY, cwd })
    return offered.data.offer_id
  }

  // No history yet in this project (the other project's record is not read).
  let offerId = await enhanceDraft()
  assert.ok(!asks[0].includes('<user_taste>'))

  // A submit that is not the user's (Claude tags it with a source) teaches nothing.
  assert.equal(await claudePrompt(env, cwd, REWRITE, 'schedule_wakeup'), '')
  assert.equal(await claudePrompt(env, cwd, REWRITE, 'sdk'), '')
  assert.equal(tasteOf(store, cwd).length, 0)
  assert.equal(offerState(store, 'claude').offer.offerId, offerId)

  // Sent unchanged (Claude tags the user's own prompts source 'user', or sends no source).
  assert.equal(await claudePrompt(env, cwd, REWRITE, 'user'), '')
  offerId = await enhanceDraft()
  assert.ok(asks[1].includes('the user sent 1 unchanged and edited 0'))

  // The user trims the rewrite before sending.
  await hook('claude', 'UserPromptSubmit', { prompt: 'Fix login in src/auth.ts' }, { cwd, env, mods })
  offerId = await enhanceDraft()
  assert.ok(asks[2].includes('the user sent 1 unchanged and edited 1'))
  assert.ok(asks[2].includes('<rewrite>Fix the login bug in src/auth.ts</rewrite>\n<sent>Fix login in src/auth.ts</sent>'))

  // A long edit is clipped, and only the last 10 records are kept.
  for (let i = 0; i < 12; i++) {
    const recorded = await client.tool('enhance', { action: 'record', sent: 'y'.repeat(1000), offer_id: offerId, cwd })
    assert.equal(recorded.data.recorded, true)
    offerId = await enhanceDraft()
  }
  const last = asks[asks.length - 1]
  assert.ok(last.includes(`Of your last ${KEEP} rewrites`))
  assert.ok(last.includes('be more thorough'))
  assert.ok(!last.includes('y'.repeat(300)))
  assert.ok(last.includes(`${'y'.repeat(299)}…`))
  assert.ok(!last.includes('other project'))
  const records = tasteOf(store, cwd)
  assert.equal(records.length, KEEP)
  assert.deepEqual(Object.keys(records[KEEP - 1]), ['edited', 'delta', 'rewrite', 'sent', 'agent', 'at'])
  assert.equal(records[KEEP - 1].agent, 'claude')
  client.close()
})

test('UserPromptSubmit: an unrelated prompt records nothing and the stale rewrite is never compared again', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('gate')
  const client = await agentClient('claude', env, cwd, store)
  await client.tool('enhance', { action: 'offer', draft: 'fix login', reply: REPLY, cwd })
  const reply = await hook('claude', 'UserPromptSubmit', { prompt: 'now check the CI status on master and summarise it' }, { cwd, env, mods })
  assert.equal(reply.raw, '')
  assert.equal(tasteOf(store, cwd).length, 0)
  assert.ok(offerState(store, 'claude').offer.answeredAt)
  // The original recorded any later send against the abandoned rewrite; even the rewrite itself, sent
  // after the user moved on, records nothing and drops the offer.
  await hook('claude', 'UserPromptSubmit', { prompt: REWRITE }, { cwd, env, mods })
  assert.equal(tasteOf(store, cwd).length, 0)
  const state = offerState(store, 'claude')
  assert.equal(state.offer, null)
  assert.equal(state.last.outcome, 'dropped')
  client.close()
})

test('UserPromptSubmit: enhancing the rewrite again is not a send of it', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('again')
  for (const [agent, prompt] of [['claude', `/enhance ${REWRITE}`], ['codex', `$enhance ${REWRITE} please`]]) {
    const client = await agentClient(agent, env, cwd, store)
    await client.tool('enhance', { action: 'offer', draft: 'fix login', reply: REPLY, cwd })
    await hook(agent, 'UserPromptSubmit', { prompt }, { cwd, env, mods })
    assert.equal(tasteOf(store, cwd).length, 0, agent)
    assert.ok(offerState(store, agent).offer.answeredAt, agent)
    client.close()
  }
})

test('send as is: the reply "send" passes the hook unrecorded, then record claims the offer once', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('asis')
  const client = await agentClient('claude', env, cwd, store)
  const offered = await client.tool('enhance', { action: 'offer', draft: 'fix login', reply: REPLY, cwd })
  const offerId = offered.data.offer_id
  await hook('claude', 'UserPromptSubmit', { prompt: 'send' }, { cwd, env, mods })
  assert.equal(tasteOf(store, cwd).length, 0)
  const recorded = await client.tool('enhance', { action: 'record', sent: `${REWRITE}\n`, offer_id: offerId, cwd })
  assert.deepEqual(recorded.data, { recorded: true, edited: false, delta: 0, kept: 1 })
  const again = await client.tool('enhance', { action: 'record', sent: REWRITE, offer_id: offerId, cwd })
  assert.equal(again.data.recorded, false)
  assert.match(again.content[0].text, /already recorded/)
  client.close()
})

test('an edit pasted as the prompt is recorded by the hook; the follow-up record call is a no-op', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('paste')
  const client = await agentClient('claude', env, cwd, store)
  const offered = await client.tool('enhance', { action: 'offer', draft: 'fix login', reply: REPLY, cwd })
  const pasted = 'Fix the login bug in src/auth.ts and add a regression test'
  await hook('claude', 'UserPromptSubmit', { prompt: pasted }, { cwd, env, mods })
  const [rec] = tasteOf(store, cwd)
  assert.equal(rec.edited, true)
  assert.equal(rec.delta, pasted.length - REWRITE.length)
  assert.equal(rec.sent, pasted)
  const follow = await client.tool('enhance', { action: 'record', sent: pasted, offer_id: offered.data.offer_id, cwd })
  assert.equal(follow.data.recorded, false)
  assert.equal(tasteOf(store, cwd).length, 1)
  client.close()
})

for (const agent of ['claude', 'codex', 'grok', 'devin']) {
  test(`${agent}: the user's send of the offered rewrite is recorded from its own hook payload; SessionEnd drops the offer`, async () => {
    const { env, store } = tempStore()
    const cwd = makeRepo(`shape-${agent}`)
    const client = await agentClient(agent, env, cwd, store)
    const prepared = await client.tool('enhance', { action: 'prepare', draft: 'fix login', cwd })
    assert.equal(prepared.data.ask, buildAsk(agent, '', 'fix login'))
    await client.tool('enhance', { action: 'offer', draft: 'fix login', reply: REPLY, cwd })
    assert.equal(offerState(store, agent).offer.agent, agent)
    // A re-wrapped paste (CRLF, extra spaces) is still the rewrite sent unchanged.
    const reply = await hook(agent, 'UserPromptSubmit', { prompt: '  Fix the login\r\nbug in src/auth.ts ' }, { cwd, env, mods })
    assert.equal(reply.raw, '', 'prints nothing')
    const records = tasteOf(store, cwd)
    assert.equal(records.length, 1)
    assert.equal(records[0].edited, false)
    assert.equal(records[0].agent, agent)

    await client.tool('enhance', { action: 'offer', draft: 'fix login', reply: REPLY, cwd })
    const end = await hook(agent, 'SessionEnd', {}, { cwd, env, mods })
    assert.equal(end.raw, '')
    assert.equal(offerState(store, agent).offer, null)
    assert.equal(offerState(store, agent).last.outcome, 'dropped')
    client.close()
  })
}

test('UserPromptSubmit: subagent prompts are ignored, and no offer means no state file', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('sub')
  await hook('codex', 'UserPromptSubmit', { prompt: 'anything' }, { cwd, env, mods })
  assert.equal(offerState(store, 'codex'), null)
  const client = await agentClient('claude', env, cwd, store)
  await client.tool('enhance', { action: 'offer', reply: REPLY, cwd })
  await hook('claude', 'UserPromptSubmit', { prompt: REWRITE, isSubagent: true }, { cwd, env, mods })
  assert.equal(tasteOf(store, cwd).length, 0)
  assert.ok(offerState(store, 'claude').offer && !offerState(store, 'claude').offer.answeredAt)
  client.close()
})

test('an offer lives 30 minutes', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('ttl')
  const client = await agentClient('claude', env, cwd, store)
  await client.tool('enhance', { action: 'offer', draft: 'fix login', reply: REPLY, cwd })
  await hook('claude', 'UserPromptSubmit', { prompt: REWRITE }, { cwd, env, mods, now: Date.now() + OFFER_TTL_MS + 60_000 })
  assert.equal(tasteOf(store, cwd).length, 0)
  assert.equal(offerState(store, 'claude').last.outcome, 'expired')

  const offered = await client.tool('enhance', { action: 'offer', draft: 'fix login', reply: REPLY, cwd })
  const offerId = offered.data.offer_id
  const key = sessionKey('claude', SESSION_IDS.claude)
  const late = recordSent(store, { key, offerId, sent: REWRITE, agent: 'claude', now: Date.now() + OFFER_TTL_MS + 1000 })
  assert.equal(late.recorded, false)
  assert.equal(offerState(store, 'claude').last.outcome, 'expired')
  // Within the TTL it would have counted.
  await client.tool('enhance', { action: 'offer', draft: 'fix login', reply: REPLY, cwd })
  const inTime = recordSent(store, { key, sent: REWRITE, agent: 'claude', now: Date.now() + OFFER_TTL_MS - 60_000 })
  assert.equal(inTime.recorded, true)
  client.close()
})

test('token-like strings never reach the store; the real rewrite still matches', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('secret')
  const key = `sk-ant-api03-${'A1b2C3d4'.repeat(6)}`
  const gh = `ghp_${'x9Y8'.repeat(9)}`
  const client = await agentClient('claude', env, cwd, store)
  const rewrite = `Deploy with key ${key} and push using ${gh}`
  const offered = await client.tool('enhance', { action: 'offer', draft: `deploy ${key}`, reply: `${rewrite}\n${MARK}\n- uses ${key}`, cwd })
  // The agent gets the real text to show the user...
  assert.equal(offered.data.text, rewrite)
  // ...the session file does not keep it.
  const stateFile = fs.readFileSync(path.join(store.root, 'sessions', sessionKey('claude', SESSION_IDS.claude), 'enhance.json'), 'utf8')
  assert.ok(!stateFile.includes(key) && !stateFile.includes(gh) && stateFile.includes('[redacted]'))
  // The exact rewrite, secrets included, still counts as sent unchanged.
  await hook('claude', 'UserPromptSubmit', { prompt: rewrite }, { cwd, env, mods })
  assert.equal(tasteOf(store, cwd)[0].edited, false)

  const second = await client.tool('enhance', { action: 'offer', draft: 'deploy', reply: rewrite, cwd })
  const bearer = `Bearer ${'Zx9'.repeat(8)}`
  const hex = '0123456789abcdef0123456789abcdef'
  const result = await client.tool('enhance', {
    action: 'record', sent: `Deploy with key ${key}, header ${bearer}, webhook ${hex}`, offer_id: second.data.offer_id, cwd,
  })
  assert.equal(result.data.edited, true)
  const tasteFile = fs.readFileSync(path.join(store.root, projectFile(projectInfo(cwd), 'taste.json')), 'utf8')
  for (const s of [key, gh, 'Zx9'.repeat(8), hex]) assert.ok(!tasteFile.includes(s), s)
  assert.ok(tasteFile.includes('Bearer [redacted]'))
  client.close()
})

test('one offer per session: a new offer replaces the last', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('replace')
  const client = await agentClient('codex', env, cwd, store)
  const first = await client.tool('enhance', { action: 'offer', reply: REPLY, cwd })
  const second = await client.tool('enhance', { action: 'offer', reply: 'Something else entirely', cwd })
  const stale = await client.tool('enhance', { action: 'record', sent: REWRITE, offer_id: first.data.offer_id, cwd })
  assert.equal(stale.data.recorded, false)
  const fresh = await client.tool('enhance', { action: 'record', sent: 'Something else entirely', offer_id: second.data.offer_id, cwd })
  assert.deepEqual(fresh.data, { recorded: true, edited: false, delta: 0, kept: 1 })
  client.close()
})

test('record finds an offer made under another session by its id', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('elsewhere')
  const maker = await agentClient('claude', env, cwd, store)
  const offered = await maker.tool('enhance', { action: 'offer', reply: REPLY, cwd })
  const other = mcpClient({ mods, env: { ...env, CLAUDE_CODE_SESSION_ID: 'some-other-session' }, clientName: 'claude-code' })
  await other.init()
  const noId = await other.tool('enhance', { action: 'record', sent: REWRITE, cwd })
  assert.equal(noId.data.recorded, false)
  const byId = await other.tool('enhance', { action: 'record', sent: REWRITE, offer_id: offered.data.offer_id, cwd })
  assert.equal(byId.data.recorded, true)
  maker.close()
  other.close()
})

test('mcp: one enhance tool; errors keep the original wording', async () => {
  const { env } = tempStore()
  const cwd = makeRepo('mcp')
  const client = mcpClient({ mods, env, clientName: 'claude-code' })
  await client.init()
  const list = await client.call('tools/list', {})
  const tool = list.result.tools.find((t) => t.name === 'enhance')
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['prepare', 'offer', 'record', 'taste', 'clear'])
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['action', 'draft', 'reply', 'sent', 'offer_id', 'cwd'])

  const empty = await client.tool('enhance', { action: 'prepare', draft: '   ', cwd })
  assert.equal(empty.isError, true)
  assert.equal(empty.content[0].text, 'Type a prompt first')
  for (const reply of ['', `${MARK}\n- only notes`]) {
    const failed = await client.tool('enhance', { action: 'offer', reply, cwd })
    assert.equal(failed.isError, true)
    assert.equal(failed.content[0].text, 'Enhance failed: empty reply')
  }
  assert.equal((await client.tool('enhance', { action: 'record', cwd })).isError, true)
  const none = await client.tool('enhance', { action: 'record', sent: 'x', cwd })
  assert.deepEqual(none.data, { recorded: false, edited: false, delta: 0, kept: 0 })
  assert.equal((await client.tool('enhance', { action: 'bogus', cwd })).isError, true)

  const prepared = await client.tool('enhance', { action: 'prepare', draft: 'fix login', cwd })
  assert.deepEqual(prepared.data, { ask: buildAsk('claude', '', 'fix login'), taste: '', records: 0 })
  assert.ok(prepared.content[0].text.startsWith(prepared.data.ask))

  const offered = await client.tool('enhance', { action: 'offer', draft: 'fix login', reply: REPLY, cwd })
  assert.deepEqual(Object.keys(offered.data), ['offer_id', 'text', 'notes'])
  assert.ok(offered.content[0].text.includes('Send as is, or paste your edited version.'))
  assert.ok(offered.content[0].text.includes(`${REWRITE}\n\n+ references src/auth.ts\n+ adds "tests pass" as done\n+ uses /code-review`))
  await client.tool('enhance', { action: 'record', sent: 'Fix login in src/auth.ts', offer_id: offered.data.offer_id, cwd })

  const taste = await client.tool('enhance', { action: 'taste', cwd })
  assert.equal(taste.data.records.length, 1)
  assert.equal(taste.data.hint, taste.content[0].text)
  assert.ok(taste.data.hint.includes('edited 1'))
  const cleared = await client.tool('enhance', { action: 'clear', cwd })
  assert.deepEqual(cleared.data, { cleared: 1 })
  const after = await client.tool('enhance', { action: 'taste', cwd })
  assert.deepEqual(after.data, { records: [], hint: '' })
  assert.match(after.content[0].text, /No taste history yet/)
  client.close()
})

test('mcp: the ask uses the calling agent\'s skill syntax', async () => {
  const { env } = tempStore()
  const cwd = makeRepo('syntax')
  const client = mcpClient({ mods, env, clientName: 'codex-mcp-client' })
  await client.init()
  const prepared = await client.tool('enhance', { action: 'prepare', draft: 'fix login', cwd })
  assert.ok(prepared.data.ask.includes('skills (as $skill-name)'))
  assert.ok(prepared.data.ask.includes('for Codex into'))
  client.close()
})

function capture() {
  let text = ''
  return { stream: { write: (s) => ((text += s), true) }, get text() { return text } }
}

async function cli(env, cwd, ...argv) {
  const out = capture()
  const err = capture()
  const code = await runCli({ argv: ['enhance', ...argv, '--cwd', cwd], env, stdout: out.stream, stderr: err.stream, mods })
  return { code, out: out.text, err: err.text }
}

test('cli: prepare, offer, record, taste, clear', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('cli')
  const files = tempDir('am-enh-')
  const prepared = await cli(env, cwd, 'prepare', 'fix', 'login', '--agent', 'codex')
  assert.equal(prepared.code, 0)
  assert.equal(prepared.out, `${buildAsk('codex', '', 'fix login')}\n`)
  const empty = await cli(env, cwd, 'prepare')
  assert.equal(empty.code, 1)
  assert.match(empty.err, /Type a prompt first/)

  // A reply saved by PowerShell: BOM and CRLF.
  fs.writeFileSync(path.join(files, 'reply.txt'), `\uFEFF${REPLY.replace(/\n/g, '\r\n')}\r\n`)
  fs.writeFileSync(path.join(files, 'draft.txt'), 'fix login')
  const offered = await cli(env, cwd, 'offer', '--draft', path.join(files, 'draft.txt'), '--reply', path.join(files, 'reply.txt'), '--json')
  assert.equal(offered.code, 0)
  const offer = JSON.parse(offered.out)
  assert.equal(offer.text, REWRITE)
  assert.equal(offer.notes.length, 3)
  const shown = await cli(env, cwd, 'offer', '--reply', path.join(files, 'reply.txt'))
  assert.ok(shown.out.startsWith(`${REWRITE}\n\n+ references src/auth.ts\n`))
  const shownId = /offer ([0-9a-f]+):/.exec(shown.out)[1]
  // The second offer replaced the first in the terminal's slot.
  const stale = await cli(env, cwd, 'record', '--sent', path.join(files, 'draft.txt'), '--offer', offer.offer_id)
  assert.match(stale.out, /Nothing recorded/)

  fs.writeFileSync(path.join(files, 'sent.txt'), 'Fix login in src/auth.ts\r\n')
  const recorded = await cli(env, cwd, 'record', '--sent', path.join(files, 'sent.txt'), '--offer', shownId)
  assert.equal(recorded.code, 0)
  assert.match(recorded.out, /Recorded \(edited, -8 characters\)/)
  await cli(env, cwd, 'offer', '--reply', path.join(files, 'reply.txt'))
  const unchanged = await cli(env, cwd, 'record', '--unchanged', '--json')
  assert.deepEqual(JSON.parse(unchanged.out), { recorded: true, edited: false, delta: 0, kept: 2 })
  const missing = await cli(env, cwd, 'record', '--sent', path.join(files, 'nope.txt'))
  assert.equal(missing.code, 1)
  assert.match(missing.err, /Cannot read --sent/)

  const tasteJson = JSON.parse((await cli(env, cwd, 'taste', '--json')).out)
  assert.equal(tasteJson.records.length, 2)
  assert.equal(tasteJson.hint, tasteHint(tasteOf(store, cwd)))
  const tasteText = (await cli(env, cwd, 'taste')).out
  assert.ok(tasteText.includes('2 rewrites remembered') && tasteText.includes('The next rewrite gets:') && tasteText.includes('<user_taste>'))
  assert.match((await cli(env, cwd, 'clear')).out, /Cleared 2 taste records/)
  assert.match((await cli(env, cwd, 'taste')).out, /No taste history yet/)
  assert.equal((await cli(env, cwd, 'bogus')).code, 2)
})

test('cli: the offer belongs to the agent session whose shell runs it', async () => {
  const { env, store } = tempStore()
  const cwd = makeRepo('shell')
  const files = tempDir('am-enh-')
  fs.writeFileSync(path.join(files, 'reply.txt'), REPLY)
  const shellEnv = { ...env, CODEX_THREAD_ID: SESSION_IDS.codex }
  const offered = await cli(shellEnv, cwd, 'offer', '--reply', path.join(files, 'reply.txt'), '--json')
  assert.equal(offerState(store, 'codex').offer.offerId, JSON.parse(offered.out).offer_id)
  // So that session's own prompt hook sees the user's answer.
  await hook('codex', 'UserPromptSubmit', { prompt: REWRITE }, { cwd, env, mods })
  assert.equal(tasteOf(store, cwd)[0].agent, 'codex')
  // An explicit --session with no known agent stays on that id instead of guessing a live session.
  const pinned = JSON.parse((await cli(env, cwd, 'offer', '--reply', path.join(files, 'reply.txt'), '--session', 'abc', '--json')).out)
  assert.equal(sessionState(store, sessionKey('any', 'abc'), 'enhance').read(null).offer.offerId, pinned.offer_id)
  const byPin = JSON.parse((await cli(env, cwd, 'record', '--unchanged', '--session', 'abc', '--json')).out)
  assert.equal(byPin.recorded, true)
})

test('skill: frontmatter follows the contract', () => {
  const text = fs.readFileSync(path.join(ROOT, 'skills', 'enhance', 'SKILL.md'), 'utf8')
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text)[1]
  assert.equal(/^name: (.*)$/m.exec(front)[1], 'enhance')
  const description = /^description: (.*)$/m.exec(front)[1]
  assert.ok(description.length < 1024 && !/[<>]/.test(description) && !/: /.test(description))
  assert.ok(text.includes('Send as is, or paste your edited version.'))
  assert.ok(text.includes('agent-mods enhance prepare') && text.includes('mcp__agent-mods__enhance'))
})

test('cli: --reply - reads stdin and strips the BOM PowerShell adds', () => {
  const { root } = tempStore()
  const cwd = makeRepo('stdin')
  const script = [
    `import { runCli } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'lib', 'core', 'cli.mjs')).href)}`,
    `import mod from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'lib', 'mods', 'enhance.mjs')).href)}`,
    'process.exitCode = await runCli({ argv: process.argv.slice(1), mods: [mod] })',
  ].join('\n')
  // A minimal env: no agent session variables leak in from the shell running the tests.
  const childEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, AGENT_MODS_HOME: root }
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, 'enhance', 'offer', '--reply', '-', '--cwd', cwd, '--json'], {
    input: `\uFEFF${REPLY.replace(/\n/g, '\r\n')}`,
    env: childEnv,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const offer = JSON.parse(result.stdout)
  assert.equal(offer.text, REWRITE)
  assert.deepEqual(offer.notes, ['references src/auth.ts', 'adds "tests pass" as done', 'uses /code-review'])
})
