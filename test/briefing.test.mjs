// The briefing tool stands in for session-start context (Grok discards it; sessions older than the
// install never got it), so one call must return what every mod's SessionStart would have injected.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODS } from '../lib/mods/index.mjs'
import { runCli } from '../lib/core/cli.mjs'
import { hook, makeRepo, mcpClient, tempStore } from './helpers.mjs'

async function cli(env, argv) {
  let out = ''
  const code = await runCli({ argv, env, stdout: { write: (t) => (out += t) }, stderr: { write: (t) => (out += t) }, mods: MODS })
  assert.equal(code, 0, `agent-mods ${argv.join(' ')}: ${out}`)
  return out
}

test('briefing: one call returns sessions, project rules, design decisions, plain rules and messages', async () => {
  const { env } = tempStore()
  const cwd = makeRepo('briefing')
  await hook('claude', 'SessionStart', {}, { cwd, env, mods: MODS })
  await hook('claude', 'UserPromptSubmit', { prompt: 'Refactor the points ledger' }, { cwd, env, mods: MODS })
  await hook('grok', 'SessionStart', {}, { cwd, env, mods: MODS, sessionId: 'grok-briefing-1' })
  await hook('grok', 'UserPromptSubmit', { prompt: 'Tidy the README' }, { cwd, env, mods: MODS, sessionId: 'grok-briefing-1' })

  const grok = mcpClient({ mods: MODS, env, clientName: 'grok' })
  const claude = mcpClient({ mods: MODS, env, clientName: 'claude-code' })
  try {
    await grok.init()
    await claude.init()
    const logged = await grok.tool('log_assumption', { assumption: 'Points are stored as integer cents', cwd, session_id: 'grok-briefing-1' })
    await cli(env, ['assumptions', 'wrong', String(logged.data.id), '--fix', 'Points are whole numbers, never cents', '--cwd', cwd])
    await claude.tool('design_decisions', { action: 'record', question: 'Card style?', choice: 'Flat cards with hairline borders', topic: 'cards', cwd })
    await cli(env, ['plain', 'expert'])
    const sent = await claude.tool('send_message', { to: 'grok-briefing-1', text: 'I am editing src/ledger.ts, hold off', cwd })
    assert.equal(sent.isError, undefined, sent.content[0].text)

    const brief = (await grok.tool('briefing', { cwd, session_id: 'grok-briefing-1' })).content[0].text
    assert.match(brief, /Refactor the points ledger/, 'other sessions')
    assert.match(brief, /Points are whole numbers, never cents/, 'project rules from corrected assumptions')
    assert.match(brief, /Flat cards with hairline borders/, 'design decisions')
    assert.match(brief, /shelve_idea/, 'idea-shelf guidance')
    assert.match(brief, /log_assumption/, 'assumption guidance')
    assert.match(brief, /# Plain talk[\s\S]*The reader is technical/, 'plain-talk rules at the expert level')
    assert.match(brief, /I am editing src\/ledger\.ts, hold off/, 'peer message, delivered once')
    assert.doesNotMatch((await grok.tool('briefing', { cwd, session_id: 'grok-briefing-1' })).content[0].text, /hold off/, 'not delivered twice')

    await cli(env, ['config', 'set', 'mods.design', 'false'])
    const without = (await grok.tool('briefing', { cwd, session_id: 'grok-briefing-1' })).content[0].text
    assert.doesNotMatch(without, /Flat cards/, 'a disabled mod adds nothing')
    assert.match(without, /Points are whole numbers/)
  } finally {
    grok.close()
    claude.close()
  }
})

test('briefing: with nothing to say, it says so', async () => {
  const { env } = tempStore()
  const cwd = makeRepo('quiet')
  const sessionsOnly = MODS.filter((m) => m.name === 'sessions')
  const client = mcpClient({ mods: sessionsOnly, env, clientName: 'grok' })
  try {
    await client.init()
    const listed = (await client.call('tools/list', {})).result.tools.map((t) => t.name)
    assert.ok(listed.includes('briefing'))
    assert.match((await client.tool('briefing', { cwd })).content[0].text, /^No other agent sessions/)
  } finally {
    client.close()
  }
})
