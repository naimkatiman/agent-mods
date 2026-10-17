// The session detail's brief: first user prompt, context used, and the suggested next prompt.
// Fixtures only. Nothing here reads a real agent home.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { claudeProjectSlug, contextLabel, continuePrompt, promptFromText, readBrief, suggestNext, PROMPT_MAX, SUGGEST_MAX } from '../lib/dashboard/brief.mjs'
import { tempDir } from './helpers.mjs'

test('promptFromText keeps the user query and drops harness text', () => {
  assert.equal(promptFromText('<user_info>os</user_info>'), null)
  assert.equal(promptFromText('<system-reminder>skills</system-reminder>'), null)
  assert.equal(promptFromText('<environment_context><cwd>D:\\work</cwd></environment_context>'), null)
  assert.equal(promptFromText(`# AGENTS.md instructions\n${'x'.repeat(2100)}`), null)
  assert.equal(promptFromText('<user_query>\nfix the camera\n</user_query>'), 'fix the camera')
  assert.equal(promptFromText('fix the login copy'), 'fix the login copy')
})

test('claude project slug matches the folder Claude writes', () => {
  assert.equal(claudeProjectSlug('D:\\Sample Telegram Projects\\SampleApp'), 'd--Sample-Telegram-Projects-SampleApp')
})

test('suggestNext stays short and names the next step', () => {
  const text = suggestNext({ done: 'posted the logo', doing: 'checking the queue', next: 'open the PR', answer: 'Logo stays.' })
  assert.ok(text.length <= SUGGEST_MAX, text.length)
  assert.match(text, /open the PR/)
  assert.match(text, /posted the logo/)
  assert.match(text, /Do not start over/)
  assert.match(suggestNext({}), /Continue this session/)
})

test('continuePrompt tells the session to compact, then do the box text', () => {
  const text = continuePrompt('  open the PR  ')
  assert.match(text, /^Compact this session first\./)
  assert.match(text, /Then do this prompt:\n\nopen the PR$/)
})

test('contextLabel names tokens, the window, and compactions', () => {
  assert.equal(contextLabel(null), 'Context used: not recorded for this session.')
  assert.equal(contextLabel({ used: 158400, window: 256000, percent: 62, compactions: 2 }), 'Context used: 158,400 / 256,000 (62%). Compacted 2 times.')
  assert.equal(contextLabel({ used: 152, window: null, percent: null, compactions: 0 }), 'Context used: 152 tokens on the last turn.')
  assert.match(contextLabel({ used: 10, window: 100, percent: 10, compactions: 1 }), /Compacted once/)
})

function writeLines(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n'))
}

test('readBrief: Grok keeps the first user_query and the signal counts', () => {
  const home = tempDir('am-grok-')
  const cwd = 'D:\\work\\shop'
  const id = '33333333-3333-4333-8333-333333333333'
  const dir = path.join(home, 'sessions', encodeURIComponent(cwd), id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'signals.json'), JSON.stringify({ contextTokensUsed: 158400, contextWindowTokens: 256000, compactionCount: 2 }))
  writeLines(path.join(dir, 'chat_history.jsonl'), [
    { type: 'system', content: 'You are Grok' },
    { type: 'user', content: [{ type: 'text', text: '<user_info>OS</user_info>' }] },
    { type: 'user', content: [{ type: 'text', text: '<system-reminder>skills</system-reminder>' }] },
    { type: 'user', content: [{ type: 'text', text: '<user_query>\nfix the camera\n</user_query>' }] },
    { type: 'user', content: [{ type: 'text', text: '<user_query>later turn</user_query>' }] },
  ])
  const brief = readBrief({ agent: 'grok', id, cwd, home, done: 'posted the logo', next: 'open the PR', lastPrompt: 'commit this' })
  assert.equal(brief.firstPrompt, 'fix the camera')
  assert.equal(brief.truncated, false)
  assert.deepEqual(brief.context, { used: 158400, window: 256000, percent: 62, compactions: 2 })
  assert.match(brief.suggestion, /open the PR/)
})

test('readBrief: Claude skips a sidechain and sums the last turn', () => {
  const home = tempDir('am-claude-')
  const cwd = 'D:\\Sample Telegram Projects\\SampleApp'
  const id = '11111111-1111-4111-8111-111111111111'
  writeLines(path.join(home, 'projects', claudeProjectSlug(cwd), `${id}.jsonl`), [
    { type: 'user', isSidechain: true, message: { content: [{ type: 'text', text: 'sidechain ask' }] } },
    { type: 'user', message: { content: [{ type: 'text', text: '<system-reminder>ignore</system-reminder>\n<user_query>ship the poster</user_query>' }] } },
    { type: 'assistant', message: { usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 40 } } },
    { type: 'assistant', message: { usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 50 } } },
  ])
  const brief = readBrief({ agent: 'claude', id, cwd, home, lastPrompt: 'short' })
  assert.equal(brief.firstPrompt, 'ship the poster')
  assert.deepEqual(brief.context, { used: 152, window: null, percent: null, compactions: 0 })
})

test('readBrief: Codex skips the AGENTS.md dump and reads the last token count', () => {
  const home = tempDir('am-codex-')
  const id = '44444444-4444-4444-8444-444444444444'
  const cwd = 'D:\\work\\shop'
  writeLines(path.join(home, 'sessions', '2026', '10', '14', `rollout-x-${id}.jsonl`), [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `# AGENTS.md instructions\n${'x'.repeat(2100)}` }, { type: 'input_text', text: '<environment_context><cwd>D:\\work</cwd></environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the login copy' }] } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100 }, model_context_window: 200 } } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1200 }, model_context_window: 258400 } } },
  ])
  const brief = readBrief({ agent: 'codex', id, cwd, home })
  assert.equal(brief.firstPrompt, 'fix the login copy')
  assert.deepEqual(brief.context, { used: 1200, window: 258400, percent: 0, compactions: 0 })
})

test('readBrief: a missing transcript falls back to the record, and a huge prompt is capped', () => {
  const home = tempDir('am-empty-')
  const missing = readBrief({ agent: 'grok', id: '33333333-3333-4333-8333-333333333333', cwd: 'D:\\nope', home, lastPrompt: 'commit this' })
  assert.equal(missing.firstPrompt, 'commit this')
  assert.equal(missing.context, null)

  const cwd = 'D:\\work\\shop'
  const id = '55555555-5555-4555-8555-555555555555'
  const dir = path.join(home, 'sessions', encodeURIComponent(cwd), id)
  fs.mkdirSync(dir, { recursive: true })
  writeLines(path.join(dir, 'chat_history.jsonl'), [{ type: 'user', content: [{ type: 'text', text: `<user_query>${'a'.repeat(PROMPT_MAX + 50)}</user_query>` }] }])
  const huge = readBrief({ agent: 'grok', id, cwd, home })
  assert.equal(huge.truncated, true)
  assert.equal(huge.firstPrompt.length, PROMPT_MAX)
})
