import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDemoState, demoAction, demoBrief, demoResume, demoSnapshot } from '../demo/state.mjs'

const NOW = 1_800_000_000_000
const seed = () => createDemoState(NOW)
const act = (state, type, fields = {}) => demoAction(state, { type, ...fields }, { now: NOW + 1000 })

test('sample state covers four agents and both projects without a local source', () => {
  const state = seed()
  const snap = demoSnapshot(state, NOW)
  assert.deepEqual(snap.sessions.map(s => s.agent), ['claude', 'codex', 'grok', 'devin'])
  assert.deepEqual(snap.counts, { needsYou: 1, working: 2, done: 1, open: 0, running: 4 })
  assert.equal(snap.projects.length, 2)
  for (const s of snap.sessions) {
    assert.ok(s.id.startsWith('demo-') && s.cwd.startsWith('demo://'))
    assert.ok(s.taskList.length && s.files.length)
    assert.equal(demoBrief(state, s.key).ok, true)
  }
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state)
  snap.projects[0].ideas.length = 0
  assert.ok(state.snapshot.projects[0].ideas.length, 'a rendered snapshot cannot mutate state')
})

test('a correction becomes a project rule, right adds none, and repeated verdicts fail', () => {
  const state = seed(), p = state.snapshot.projects[0], other = state.snapshot.projects[1]
  const count = p.rules.length, untouched = structuredClone(other)
  const result = act(state, 'assumption.verdict', { projectId: p.id, id: 1, verdict: 'wrong', fix: 'Keep drafts on this device.' })
  assert.equal(result.ok, true)
  assert.equal(p.rules.at(-1).correction, 'Keep drafts on this device.')
  assert.equal(p.assumptions.some(a => a.id === 1), false)
  assert.equal(act(state, 'assumption.verdict', { projectId: p.id, id: 1, verdict: 'right' }).status, 404)
  assert.equal(act(state, 'assumption.verdict', { projectId: p.id, id: 2, verdict: 'right' }).ok, true)
  assert.equal(p.rules.length, count + 1)
  assert.deepEqual(other, untouched)
  assert.equal(demoSnapshot(state).projects[0].openAssumptions, 0)
  assert.equal(act(state, 'rule.delete', { projectId: p.id, id: result.data.rule.id }).ok, true)
  assert.equal(p.rules.length, count)
})

test('ideas can be added, copied, taken, restored, dismissed and deleted locally', () => {
  const state = seed(), projectId = state.snapshot.projects[0].id
  const added = act(state, 'idea.add', { projectId, text: '  Add a reading list  ' })
  assert.equal(added.ok, true)
  const fields = { projectId, id: added.data.id }
  assert.equal(act(state, 'idea.prompt', fields).data.prompt, 'Add a reading list')
  assert.equal(act(state, 'idea.take', fields).ok, true)
  assert.equal(demoSnapshot(state).projects[0].ideas.find(i => i.id === fields.id).status, 'taken')
  assert.equal(act(state, 'idea.restore', fields).ok, true)
  assert.equal(act(state, 'idea.dismiss', fields).ok, true)
  assert.equal(demoSnapshot(state).projects[0].ideas.some(i => i.id === fields.id), false)
  assert.equal(act(state, 'idea.restore', fields).ok, true)
  assert.equal(act(state, 'idea.remove', fields).ok, true)
  assert.equal(act(state, 'idea.prompt', fields).status, 404)
})

test('settings and targeted pet commands stay scoped; messages never reach an agent', () => {
  const state = seed(), key = state.snapshot.sessions[1].key
  assert.equal(act(state, 'plain', { level: 'expert' }).ok, true)
  assert.equal(act(state, 'notify', { enabled: true }).ok, true)
  assert.equal(act(state, 'clawd', { verb: 'shades' }).data.prefs.shades, true)
  assert.equal(act(state, 'clawd', { verb: 'hat', arg: 'cowboy', key }).data.hat, 'cowboy')
  assert.equal(state.snapshot.sessions[1].hat, 'cowboy')
  assert.equal(state.snapshot.sessions[0].hat, 'tophat')
  assert.equal(act(state, 'clawd', { verb: 'hat', arg: 'halo' }).ok, true)
  assert.ok(state.snapshot.sessions.every(s => s.hat === 'halo'))
  const sent = act(state, 'continue', { key, text: 'Check the sample layout.' })
  assert.match(sent.text, /demo only/i)
  assert.equal(state.snapshot.sessions[1].unread, 1)
  assert.match(demoResume(state, key, 'powershell').command, /^echo /)
  assert.equal(demoBrief(state, 'missing').status, 404)
  assert.equal(demoResume(state, key, 'unknown').status, 400)
})

test('invalid actions leave state untouched and a new seed resets every local change', () => {
  const state = seed(), original = structuredClone(state), projectId = state.snapshot.projects[0].id
  for (const body of [null, { type: 'unknown' }, { type: 'notify', enabled: 'yes' },
    { type: 'idea.add', projectId, text: 'x'.repeat(301) },
    { type: 'assumption.verdict', projectId, id: 1, verdict: 'maybe' },
    { type: 'clawd', verb: 'hat', arg: 'unknown' }]) assert.equal(demoAction(state, body).ok, false)
  assert.deepEqual(state, original)
  act(state, 'plain', { level: 'beginner' })
  assert.notDeepEqual(state, original)
  assert.deepEqual(seed(), original, 'reset creates a fresh independent seed')
})
