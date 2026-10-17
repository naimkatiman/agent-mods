import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runCli } from '../lib/core/cli.mjs'
import { runHook } from '../lib/core/runtime.mjs'
import { projectInfo } from '../lib/core/project.mjs'
import ideas, { GUIDANCE } from '../lib/mods/ideas.mjs'
import { STOP, TAKE_TTL_MS, pathWords, promptFor, readShelf, shelfRel, words } from '../lib/mods/ideas-shelf.mjs'
import { SESSION_IDS, contextOf, envFor, hook, makeRepo, makeWorktree, mcpClient, payloadFor, tempDir, tempStore } from './helpers.mjs'

const AGENTS = ['claude', 'codex', 'grok', 'devin']
const NATIVE_EDIT_TOOL = { claude: 'Edit', codex: 'apply_patch', grok: 'search_replace', devin: 'edit' }
const CLIENT_NAMES = { claude: 'claude-code', codex: 'codex-mcp-client', grok: 'grok-cli', devin: 'devin' }
const SESSION_ENV = { claude: 'CLAUDE_CODE_SESSION_ID', codex: 'CODEX_THREAD_ID', grok: 'GROK_SESSION_ID' }
// Grok drops systemMessage, so its notices are checked through the spy below.
const SHOWS_NOTICES = new Set(['claude', 'codex', 'devin'])
// Codex invokes skills as $idea; it has no custom slash commands.
const cmdFor = (agent) => (agent === 'codex' ? '$idea' : '/idea')
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI_URL = pathToFileURL(path.join(ROOT, 'lib', 'core', 'cli.mjs')).href
const MOD_URL = pathToFileURL(path.join(ROOT, 'lib', 'mods', 'ideas.mjs')).href

// Ideas made by the CLI and MCP carry the real clock, so turns start a few ms after them.
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
const textOf = (result) => result.content[0].text
const shelfOf = (store, cwd) => readShelf(store, projectInfo(cwd)).ideas

function sink() {
  const chunks = []
  return { chunks, write: (s) => chunks.push(String(s)) > 0 }
}

async function cli(env, ...argv) {
  const stdout = sink()
  const stderr = sink()
  const code = await runCli({ argv, env, stdout, stderr, mods: [ideas] })
  return { code, out: stdout.chunks.join(''), err: stderr.chunks.join('') }
}

// Records what the mods before it put in ctx.out, including notices an agent cannot show (Grok).
function spy(seen) {
  const grab = (ctx) => seen.push({ event: ctx.ev.event, notice: ctx.out.notice.join('\n'), context: ctx.out.context.join('\n\n') })
  return { name: 'spy', hooks: { SessionStart: grab, Stop: grab } }
}

// What the sessions mod would have written: lets the MCP server find a Devin caller, which has no
// session env var.
function liveRecord(store, agent, id, cwd) {
  const project = projectInfo(cwd)
  store.writeJson(`sessions/${agent}__${id}.json`, {
    v: 1,
    agent,
    id,
    key: `${agent}__${id}`,
    cwd: project.cwd,
    worktreeKey: project.worktreeKey,
    repoKey: project.repoKey,
    beatAt: Date.now(),
    home: null,
  })
}

// An MCP client that the server resolves to `agent`'s hook session.
async function agentClient(agent, env, store, cwd) {
  const extra = SESSION_ENV[agent] ? { [SESSION_ENV[agent]]: SESSION_IDS[agent] } : {}
  if (agent === 'devin') liveRecord(store, 'devin', SESSION_IDS.devin, cwd)
  const client = mcpClient({ mods: [ideas], env: { ...env, ...extra }, clientName: CLIENT_NAMES[agent] })
  await client.init()
  return client
}

function runNode(code, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, ...env }, windowsHide: true })
    const out = []
    const err = []
    child.stdout.on('data', (d) => out.push(String(d)))
    child.stderr.on('data', (d) => err.push(String(d)))
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, out: out.join(''), err: err.join('') }))
  })
}

// Both children import the modules, then spin until the same instant so their writes overlap.
function childScript(startAt, body) {
  return [
    `import { runCli } from ${JSON.stringify(CLI_URL)}`,
    `import ideas from ${JSON.stringify(MOD_URL)}`,
    'const quiet = { write: () => true }',
    `while (Date.now() < ${startAt}) {}`,
    ...body,
  ].join('\n')
}

test('ported text: guidance, tool contract, stop words, tokenizer and the send() prompt', () => {
  assert.equal(
    GUIDANCE,
    '# Idea shelf\nWhen you notice a tangent or side improvement that is not part of the current task (a refactor, a missing test, a cleanup, a follow-up feature), do not act on it mid-task. Call the agent-mods `shelve_idea` tool with a one-line description that names the files or area it concerns, then carry on with the task. The user reviews shelved ideas later.',
  )
  const tool = ideas.tools.find((t) => t.name === 'shelve_idea')
  assert.equal(
    tool.description,
    'Shelve a side idea or tangent for the user to review later, instead of acting on it now. Use for improvements noticed mid-task that are outside its scope. Name the files or area it concerns.',
  )
  assert.deepEqual(tool.inputSchema.required, ['text'])
  assert.equal(tool.inputSchema.properties.text.description, 'The idea, one line')
  for (const word of ['this', 'those', 'file', 'idea', 'update', 'change']) assert.ok(STOP.has(word), word)
  assert.deepEqual(words('speed up parsing'), ['speed', 'parsing'])
  assert.deepEqual(words('splitParserOutput into snake_case files'), ['split', 'parser', 'output', 'snake', 'case'])
  assert.deepEqual(pathWords('/proj/a/src/parser.ts'), ['parser'])
  // The original split on '/' only (register.tsx:30-32): a Windows path was tokenized whole.
  const win = 'D:\\Sample Telegram Projects\\SampleApp\\src\\routes\\referral.ts'
  assert.deepEqual(words(win.split('/').slice(-2).join(' ')), ['sample', 'telegram', 'project', 'sample', 'route', 'referral'])
  assert.deepEqual(pathWords(win), ['route', 'referral'])
  assert.equal(promptFor([{ text: 'try a cache later' }]), 'try a cache later')
  assert.equal(promptFor([{ text: 'a' }, { text: 'b' }]), 'Shelved ideas to pick up:\n- a\n- b')
})

test('skill: idea/SKILL.md frontmatter and body follow the contract', () => {
  const text = fs.readFileSync(path.join(ROOT, 'skills', 'idea', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n')
  const head = /^---\n([\s\S]*?)\n---\n/.exec(text)
  assert.ok(head, 'frontmatter')
  const fields = Object.fromEntries(head[1].split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]))
  assert.equal(fields.name, 'idea')
  assert.ok(fields.description.length > 0 && fields.description.length < 1024)
  assert.doesNotMatch(fields.description, /[<>]/)
  assert.match(text, /the agent-mods `shelve_idea` and `ideas` tools/)
  assert.match(text, /"as_user": true/)
  assert.match(text, /agent-mods idea add <text>/)
})

test('shelve as the user, take hands the text back; one shelf per repo, shared by its worktrees', async () => {
  const { env, store } = tempStore()
  const repo = makeRepo('shop')
  const added = await cli(env, 'idea', 'add', 'try', 'a', 'cache', 'later', '--cwd', repo)
  assert.equal(added.code, 0)
  assert.equal(added.out, 'Shelved: try a cache later\n')
  const project = projectInfo(repo)
  assert.equal(shelfRel(project), `projects/${project.projectId}/ideas.json`)
  const file = store.readJson(shelfRel(project))
  assert.equal(file.v, 1)
  assert.equal(file.ideas.length, 1)
  assert.equal(file.ideas[0].text, 'try a cache later')
  assert.equal(file.ideas[0].source, 'you')
  assert.equal(file.ideas[0].status, 'open')
  assert.match(file.ideas[0].id, /^\d{13}-[a-z0-9]{4}$/)

  // The /idea skill shelves through the tool as the user.
  const client = await agentClient('claude', env, store, repo)
  const viaTool = await client.tool('shelve_idea', { text: 'rename the logo asset', as_user: true, cwd: repo })
  assert.equal(textOf(viaTool), 'Shelved for the user: rename the logo asset')
  assert.equal(viaTool.data.source, 'you')

  // Every worktree and subfolder of the repo sees the same shelf; another repo has its own.
  const wt = makeWorktree(repo, 'feature')
  const listed = await client.tool('ideas', { action: 'list', cwd: wt })
  assert.deepEqual(listed.data.ideas.map((i) => i.text), ['try a cache later', 'rename the logo asset'])
  assert.match(textOf(listed), /^Idea shelf for shop: 2 open ideas\. .*do not act on them unless the user asks\.\n1\. try a cache later {2}\(you, just now\)\n2\. rename the logo asset {2}\(you, just now\)$/)
  const fromSrc = JSON.parse((await cli(env, 'idea', 'list', '--json', '--cwd', path.join(repo, 'src'))).out)
  assert.equal(fromSrc.ideas.length, 2)
  const other = makeRepo('other')
  assert.equal(textOf(await client.tool('ideas', { action: 'list', cwd: other })), 'Shelf empty. Add with /idea <text>.')

  // Numbers the session saw for one project never resolve against another project's shelf.
  const taken = await client.tool('ideas', { action: 'take', ids: ['1'], cwd: repo })
  assert.equal(taken.data.prompt, 'try a cache later')
  assert.match(textOf(taken), /carry this out as their request:\n\ntry a cache later\n/)
  const after = await client.tool('ideas', { action: 'list', cwd: repo })
  assert.deepEqual(after.data.ideas.map((i) => i.text), ['rename the logo asset'])
  client.close()
})

test('numbers mean what the session was shown, even after another session changed the shelf', async () => {
  const { env, store } = tempStore()
  const repo = makeRepo('numbers')
  for (const text of ['alpha caching pass', 'bravo logging pass', 'charlie metrics pass']) await cli(env, 'idea', 'add', text, '--cwd', repo)
  const claude = await agentClient('claude', env, store, repo)
  await claude.tool('ideas', { action: 'list', cwd: repo })
  // Meanwhile another terminal removes #1 and adds one.
  await cli(env, 'idea', 'rm', '1', '--cwd', repo)
  await cli(env, 'idea', 'add', 'delta tracing pass', '--cwd', repo)
  assert.equal((await claude.tool('ideas', { action: 'take', ids: ['2'], cwd: repo })).data.prompt, 'bravo logging pass')
  assert.equal(textOf(await claude.tool('ideas', { action: 'take', ids: ['1'], cwd: repo })), 'Not available: 1 (not on the shelf).')
  // The CLI has no session, so its numbers are the current order.
  assert.equal((await cli(env, 'idea', 'take', '1', '--cwd', repo)).out, 'charlie metrics pass\n')
  claude.close()
})

for (const agent of AGENTS) {
  test(`${agent}: same-turn exclusion, dismiss, earlier-turn nudge, send completes at Stop, unrelated turn silent`, async () => {
    const { env, store } = tempStore()
    const repo = makeRepo('proj')
    const parser = path.join(repo, 'src', 'parser.ts')
    const readme = path.join(repo, 'README.md')
    const seen = []
    const mods = [ideas, spy(seen)]
    const run = (event, fields = {}) => hook(agent, event, fields, { cwd: repo, env, mods, now: Date.now() })
    const stopNotice = () => seen.filter((s) => s.event === 'Stop').at(-1).notice
    const edit = payloadFor(agent, 'PostToolUse', { tool: 'edit', file: parser }, { cwd: repo })
    assert.equal(edit.tool_name ?? edit.toolName, NATIVE_EDIT_TOOL[agent])

    await cli(env, 'idea', 'add', 'cache the parser output', '--cwd', repo)
    await cli(env, 'idea', 'add', 'rename the logo asset', '--cwd', repo)
    const client = await agentClient(agent, env, store, repo)
    await tick()

    // Turn 1: the agent's own parser idea, shelved this very turn, is not nudged back at once.
    await run('UserPromptSubmit', { prompt: 'speed up parsing' })
    await run('PostToolUse', { tool: 'edit', file: parser })
    const shelved = await client.tool('shelve_idea', { text: 'split parser.ts into lexer and grammar', cwd: repo })
    assert.equal(textOf(shelved), 'Shelved for the user: split parser.ts into lexer and grammar')
    assert.deepEqual(shelfOf(store, repo).map((i) => i.source), ['you', 'you', agent])
    const stop1 = await run('Stop')
    const cmd = cmdFor(agent)
    const nudge1 = `💡 1 shelved idea fits what you just did: [1] cache the parser output (pick up: ${cmd} send 1 or agent-mods idea take 1; mute: ${cmd} dismiss 1)`
    assert.equal(stopNotice(), nudge1)
    if (SHOWS_NOTICES.has(agent)) assert.deepEqual(stop1.json, { systemMessage: nudge1 })
    else assert.equal(stop1.raw, '')

    // Dismiss mutes that idea for the rest of this session.
    const dismissed = await client.tool('ideas', { action: 'dismiss', ids: ['1'], cwd: repo })
    assert.equal(textOf(dismissed), 'Dismissed for the rest of this session (no more nudges): cache the parser output')
    await tick()

    // Turn 2: the agent's idea is from an earlier turn now, so it is nudged.
    await run('UserPromptSubmit', { prompt: 'more parser work' })
    await run('PostToolUse', { tool: 'edit', file: parser })
    await run('Stop')
    assert.equal(stopNotice(), `💡 1 shelved idea fits what you just did: [3] split parser.ts into lexer and grammar (pick up: ${cmd} send 3 or agent-mods idea take 3; mute: ${cmd} dismiss 3)`)
    await tick()

    // Turn 3: '/idea send 3' takes it; it leaves the shelf when that turn ends.
    await run('UserPromptSubmit', { prompt: `${cmd} send 3` })
    const taken = await client.tool('ideas', { action: 'take', ids: ['3'], cwd: repo })
    assert.equal(taken.data.prompt, 'split parser.ts into lexer and grammar')
    assert.equal(taken.data.taken[0].source, agent)
    assert.equal(shelfOf(store, repo).find((i) => i.text.startsWith('split')).status, 'taken')
    await run('Stop')
    assert.equal(stopNotice(), '')
    assert.deepEqual(shelfOf(store, repo).map((i) => i.text), ['cache the parser output', 'rename the logo asset'])
    await tick()

    // Turn 4: unrelated ground nudges nothing.
    await run('UserPromptSubmit', { prompt: 'tidy the readme' })
    await run('PostToolUse', { tool: 'edit', file: readme })
    const stop4 = await run('Stop')
    assert.equal(stopNotice(), '')
    assert.equal(stop4.raw, '')
    client.close()
  })
}

test('Windows paths: an edit is keyed by its file and folder inside the repo, never the whole absolute path', async () => {
  const { env } = tempStore()
  const repo = path.join(tempDir('am-win-'), 'Sample Telegram Projects', 'SampleApp')
  for (const dir of ['.git', 'docs', path.join('src', 'routes'), path.join('src', 'telegram')]) {
    fs.mkdirSync(path.join(repo, dir), { recursive: true })
  }
  await cli(env, 'idea', 'add', 'add retry to the telegram webhook handler', '--cwd', repo)
  await tick()
  const turn = async (prompt, file) => {
    await hook('claude', 'UserPromptSubmit', { prompt }, { cwd: repo, env, mods: [ideas], now: Date.now() })
    // Claude sends the native Windows spelling: 'C:\...\Sample Telegram Projects\SampleApp\README.md'.
    await hook('claude', 'PostToolUse', { tool: 'edit', file }, { cwd: repo, env, mods: [ideas], now: Date.now() })
    return hook('claude', 'Stop', {}, { cwd: repo, env, mods: [ideas], now: Date.now() })
  }
  for (const file of ['README.md', path.join('docs', 'README.md'), path.join('src', 'routes', 'referral.ts')]) {
    const reply = await turn('tidy the readme', path.join(repo, file))
    assert.equal(reply.raw, '', file)
  }
  const related = await turn('tidy the readme', path.join(repo, 'src', 'telegram', 'webhook.ts'))
  assert.match(related.json.systemMessage, /1 shelved idea fits what you just did: \[1\] add retry to the telegram webhook handler/)
})

test('concurrent adds from two processes all survive (the original wrote the whole list back)', async () => {
  const { env, store } = tempStore()
  const repo = makeRepo('race')
  const startAt = Date.now() + 1500
  const adds = (tag) => childScript(startAt, [
    'for (let i = 0; i < 40; i++) {',
    `  const argv = ['idea', 'add', ${JSON.stringify(tag)} + i + ' cache layer', '--cwd', ${JSON.stringify(repo)}]`,
    '  const code = await runCli({ argv, env: process.env, stdout: quiet, stderr: quiet, mods: [ideas] })',
    "  if (code !== 0) throw new Error('add failed with ' + code)",
    '}',
  ])
  const results = await Promise.all([runNode(adds('left'), env), runNode(adds('right'), env)])
  for (const r of results) assert.equal(r.status, 0, r.err)
  const texts = shelfOf(store, repo).map((i) => i.text)
  assert.equal(texts.length, 80)
  for (const tag of ['left', 'right']) {
    for (let i = 0; i < 40; i++) assert.ok(texts.includes(`${tag}${i} cache layer`), `${tag}${i}`)
  }
})

test('take is exclusive: two processes race for one idea and exactly one gets it', async () => {
  const { env, store } = tempStore()
  const repo = makeRepo('claim')
  await cli(env, 'idea', 'add', 'cache the parser output', '--cwd', repo)
  const startAt = Date.now() + 1500
  const takeOne = childScript(startAt, [
    'const chunks = []',
    'const out = { write: (s) => chunks.push(String(s)) > 0 }',
    `const code = await runCli({ argv: ['idea', 'take', '1', '--cwd', ${JSON.stringify(repo)}], env: process.env, stdout: out, stderr: quiet, mods: [ideas] })`,
    "process.stdout.write(JSON.stringify({ code, out: chunks.join('') }))",
  ])
  const results = await Promise.all([runNode(takeOne, env), runNode(takeOne, env)])
  for (const r of results) assert.equal(r.status, 0, r.err)
  const outcomes = results.map((r) => JSON.parse(r.out)).sort((a, b) => a.code - b.code)
  assert.deepEqual(outcomes, [{ code: 0, out: 'cache the parser output\n' }, { code: 1, out: '' }])
  assert.equal(shelfOf(store, repo)[0].status, 'taken')
})

test('take across agents: one claim at a time, a session may re-take its own, Stop completes only its own', async () => {
  const { env, store } = tempStore()
  const repo = makeRepo('agents')
  await cli(env, 'idea', 'add', 'cache the parser output', '--cwd', repo)
  await cli(env, 'idea', 'add', 'rename the logo asset', '--cwd', repo)
  const [first, second] = shelfOf(store, repo)
  const claude = await agentClient('claude', env, store, repo)
  const codex = await agentClient('codex', env, store, repo)

  assert.equal((await claude.tool('ideas', { action: 'take', ids: [first.id], cwd: repo })).isError, undefined)
  const lost = await codex.tool('ideas', { action: 'take', ids: [first.id], cwd: repo })
  assert.equal(lost.isError, true)
  assert.equal(textOf(lost), `Not available: ${first.id} (taken by Claude Code just now).`)
  assert.deepEqual(lost.data, { prompt: '', taken: [], missing: [first.id] })
  assert.equal((await claude.tool('ideas', { action: 'take', ids: [first.id], cwd: repo })).data.prompt, 'cache the parser output')
  await codex.tool('ideas', { action: 'take', ids: [second.id], cwd: repo })

  // Claude's turn ends: its take is done and leaves the shelf; Codex's stays taken until Codex stops.
  await hook('claude', 'Stop', {}, { cwd: repo, env, mods: [ideas], now: Date.now() })
  assert.deepEqual(shelfOf(store, repo).map((i) => [i.text, i.status]), [['rename the logo asset', 'taken']])
  await hook('codex', 'Stop', {}, { cwd: repo, env, mods: [ideas], now: Date.now() })
  assert.deepEqual(shelfOf(store, repo), [])

  // A take that expired is back on the shelf; a later Stop of the same (resumed) session must not
  // delete what the user now sees as open.
  await cli(env, 'idea', 'add', 'retry flaky uploads', '--cwd', repo)
  await claude.tool('ideas', { action: 'take', ids: ['1'], cwd: repo })
  const rel = shelfRel(projectInfo(repo))
  const raw = store.readJson(rel)
  store.writeJson(rel, { ...raw, ideas: raw.ideas.map((i) => ({ ...i, takenBy: { ...i.takenBy, at: Date.now() - TAKE_TTL_MS - 1 } })) })
  await hook('claude', 'Stop', {}, { cwd: repo, env, mods: [ideas], now: Date.now() })
  assert.deepEqual(shelfOf(store, repo).map((i) => i.text), ['retry flaky uploads'])
  assert.match((await cli(env, 'idea', 'list', '--cwd', repo)).out, /1\. retry flaky uploads {2}\(you, just now\)/)
  claude.close()
  codex.close()
})

test('a take nobody completes is back on the shelf after 2 h; restore and remove', async () => {
  const { env, store } = tempStore()
  const repo = makeRepo('window')
  await cli(env, 'idea', 'add', 'first caching pass', '--cwd', repo)
  await cli(env, 'idea', 'add', 'second logging pass', '--cwd', repo)

  const taken = await cli(env, 'idea', 'take', '1', '--cwd', repo)
  assert.equal(taken.code, 0)
  assert.equal(taken.out, 'first caching pass\n')
  const id = shelfOf(store, repo)[0].id
  assert.equal(taken.err, `Marked taken. Back on the shelf in 2 h unless removed: agent-mods idea rm ${id}\n`)
  assert.match((await cli(env, 'idea', 'list', '--cwd', repo)).out, /^window: 1 shelved idea\n {2}1\. second logging pass/)
  assert.match((await cli(env, 'idea', 'list', '--include-taken', '--cwd', repo)).out, /2\. first caching pass {2}\(you, just now; taken by you just now\)/)

  // Nobody completed it: two hours later it reads as open again, everywhere.
  const rel = shelfRel(projectInfo(repo))
  const raw = store.readJson(rel)
  store.writeJson(rel, { ...raw, ideas: raw.ideas.map((i) => (i.id === id ? { ...i, takenBy: { ...i.takenBy, at: Date.now() - TAKE_TTL_MS - 60_000 } } : i)) })
  assert.match((await cli(env, 'idea', 'list', '--cwd', repo)).out, /^window: 2 shelved ideas\n {2}1\. first caching pass/)
  const start = await hook('claude', 'SessionStart', {}, { cwd: repo, env, mods: [ideas] })
  assert.equal(start.json.systemMessage, '💡 2 shelved ideas in this project (/idea to view)')
  const codex = await agentClient('codex', env, store, repo)
  const retaken = await codex.tool('ideas', { action: 'take', ids: [id], cwd: repo })
  assert.equal(retaken.data.prompt, 'first caching pass')

  // Explicit restore puts it back; remove deletes.
  const restored = await codex.tool('ideas', { action: 'restore', ids: [id], cwd: repo })
  assert.equal(textOf(restored), 'Restored 1 idea: first caching pass')
  assert.equal(shelfOf(store, repo)[0].status, 'open')
  assert.equal(shelfOf(store, repo)[0].takenBy, undefined)
  const notTaken = await codex.tool('ideas', { action: 'restore', ids: [id], cwd: repo })
  assert.equal(notTaken.isError, true)
  assert.equal(textOf(notTaken), `Not available: ${id} (not taken).`)
  const removed = await codex.tool('ideas', { action: 'remove', ids: ['2'], cwd: repo })
  assert.equal(textOf(removed), 'Removed 1 idea: second logging pass')
  assert.deepEqual(shelfOf(store, repo).map((i) => i.text), ['first caching pass'])
  codex.close()
})

test('SessionStart: a count for the user, the guidance for the model, never idea texts', async () => {
  const repo = makeRepo('start')
  for (const agent of AGENTS) {
    const { env } = tempStore()
    const empty = await hook(agent, 'SessionStart', {}, { cwd: repo, env, mods: [ideas] })
    if (agent === 'grok') assert.equal(empty.raw, '')
    else assert.deepEqual(empty.json, { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: GUIDANCE } }, agent)
  }
  const { env } = tempStore()
  await cli(env, 'idea', 'add', 'cache the parser output', '--cwd', repo)
  for (const agent of AGENTS) {
    const notice = `💡 1 shelved idea in this project (${cmdFor(agent)} to view)`
    const seen = []
    const reply = await hook(agent, 'SessionStart', {}, { cwd: repo, env, mods: [ideas, spy(seen)] })
    assert.equal(seen[0].notice, notice, agent)
    assert.equal(seen[0].context, GUIDANCE, agent)
    if (SHOWS_NOTICES.has(agent)) {
      assert.equal(reply.json.systemMessage, notice, agent)
      assert.equal(contextOf(reply), GUIDANCE, agent)
    } else {
      // Grok cannot take SessionStart output: the guidance waits for its next tool call.
      assert.equal(reply.raw, '')
      const next = await hook('grok', 'PostToolUse', { tool: 'edit', file: path.join(repo, 'src', 'a.ts') }, { cwd: repo, env, mods: [ideas] })
      assert.equal(contextOf(next), GUIDANCE)
    }
    assert.ok(!contextOf(reply).includes('parser'), agent)
  }
  await cli(env, 'idea', 'add', 'rename the logo asset', '--cwd', repo)
  const two = await hook('claude', 'SessionStart', {}, { cwd: repo, env, mods: [ideas] })
  assert.equal(two.json.systemMessage, '💡 2 shelved ideas in this project (/idea to view)')
  const compact = await hook('claude', 'SessionStart', { source: 'compact' }, { cwd: repo, env, mods: [ideas] })
  assert.equal(compact.json.systemMessage, undefined)
  assert.equal(contextOf(compact), GUIDANCE)
})

test('shelve_idea: validation, one line, near-duplicates, the per-session cap, sources and files', async () => {
  const { env, store } = tempStore()
  const repo = makeRepo('tool')
  const claude = await agentClient('claude', env, store, repo)
  for (const text of [undefined, '', '  \n\t ']) {
    const reply = await claude.tool('shelve_idea', { text, cwd: repo })
    assert.equal(reply.isError, true)
    assert.equal(textOf(reply), 'shelve_idea needs a non-empty `text`.')
  }
  const long = await claude.tool('shelve_idea', { text: 'x'.repeat(301), cwd: repo })
  assert.equal(long.isError, true)
  assert.equal(textOf(long), 'shelve_idea needs `text` of at most 300 characters, on one line.')

  // Control characters (BEL, ESC) go, line breaks fold: idea text reaches other prompts and terminals.
  const first = await claude.tool('shelve_idea', { text: 'cache the parser\noutput\u0007\u001b now', files: ['src/parser.ts', 7, ''], cwd: repo })
  assert.equal(textOf(first), 'Shelved for the user: cache the parser output now')
  assert.equal(first.data.source, 'claude')
  assert.equal(first.data.count, 1)
  assert.deepEqual(shelfOf(store, repo)[0].files, ['src/parser.ts'])

  const dup = await claude.tool('shelve_idea', { text: 'Cache parser outputs NOW', cwd: repo })
  assert.equal(textOf(dup), 'Already shelved for the user: cache the parser output now')
  assert.equal(dup.data.duplicate_of, first.data.id)
  assert.equal(shelfOf(store, repo).length, 1)

  // One new idea so far (the duplicate is free): nine more fit under the cap, the eleventh does not.
  for (let i = 0; i < 9; i++) {
    const reply = await claude.tool('shelve_idea', { text: `topic${i} refactor`, cwd: repo })
    assert.equal(reply.isError, undefined, `topic${i}`)
  }
  const capped = await claude.tool('shelve_idea', { text: 'one more distinct thought', cwd: repo })
  assert.equal(capped.isError, true)
  assert.equal(textOf(capped), 'This session has already shelved 10 ideas, the limit. Carry on with the task; mention any further side ideas in your final reply instead.')
  const user = await claude.tool('shelve_idea', { text: 'the user may still shelve', as_user: true, cwd: repo })
  assert.equal(user.data.source, 'you')

  // No resolvable session: no cap, and the idea is labelled 'agent', never passed off as the user's.
  const stranger = mcpClient({ mods: [ideas], env, clientName: 'mystery-client' })
  await stranger.init()
  for (let i = 0; i < 11; i++) {
    const reply = await stranger.tool('shelve_idea', { text: `stranger${i} idea`, cwd: repo })
    assert.equal(reply.data.source, 'agent')
  }
  const codex = await agentClient('codex', env, store, repo)
  assert.equal((await codex.tool('shelve_idea', { text: 'codex noticed a flaky test', cwd: repo })).data.source, 'codex')
  const list = textOf(await codex.tool('ideas', { cwd: repo }))
  assert.match(list, /\d+\. stranger0 idea {2}\(agent, just now\)/)
  assert.match(list, /\d+\. codex noticed a flaky test {2}\(Codex, just now\)/)
  assert.match(list, /1\. cache the parser output now \[src\/parser\.ts\] {2}\(Claude Code, just now\)/)
  const bad = await codex.tool('ideas', { action: 'explode', cwd: repo })
  assert.equal(textOf(bad), 'Unknown action "explode". Use one of: list, take, restore, remove, dismiss.')
  assert.equal(textOf(await codex.tool('ideas', { action: 'take', cwd: repo })), 'ideas take needs `ids`: idea ids, or numbers from the list.')
  for (const client of [claude, stranger, codex]) client.close()
})

test('Stop: never blocks, skips stop_hook_active and subagents; subagent edits count, failed ones do not', async () => {
  const { env } = tempStore()
  const repo = makeRepo('stops')
  const parser = path.join(repo, 'src', 'parser.ts')
  const at = (fields = {}) => ({ cwd: repo, env, mods: [ideas], now: Date.now(), ...fields })
  await cli(env, 'idea', 'add', 'cache the parser output', '--cwd', repo)
  await tick()

  await hook('claude', 'UserPromptSubmit', { prompt: 'speed up the parser' }, at())
  assert.equal((await hook('claude', 'Stop', { stopHookActive: true }, at())).raw, '')
  assert.equal((await hook('claude', 'Stop', { isSubagent: true }, at())).raw, '')
  const stop = await hook('claude', 'Stop', {}, at())
  assert.deepEqual(Object.keys(stop.json), ['systemMessage'])

  await hook('claude', 'UserPromptSubmit', { prompt: 'tidy up' }, at())
  const failed = { ...payloadFor('claude', 'PostToolUse', { tool: 'edit', file: parser }, { cwd: repo }), tool_response: { success: false } }
  await runHook({ env: envFor('claude', { cwd: repo, base: env }), stdinText: JSON.stringify(failed), now: Date.now(), mods: [ideas] })
  assert.equal((await hook('claude', 'Stop', {}, at())).raw, '')

  await hook('claude', 'UserPromptSubmit', { prompt: 'tidy up' }, at())
  await hook('claude', 'PostToolUse', { tool: 'edit', file: parser, isSubagent: true }, at())
  assert.match((await hook('claude', 'Stop', {}, at())).json.systemMessage, /\[1\] cache the parser output/)
})

test('nudge: several fits share one line with the plural label, five shown at most', async () => {
  const { env } = tempStore()
  const repo = makeRepo('many')
  const at = () => ({ cwd: repo, env, mods: [ideas], now: Date.now() })
  for (let i = 0; i < 7; i++) await cli(env, 'idea', 'add', `parser idea${i}`, '--cwd', repo)
  await tick()
  await hook('claude', 'UserPromptSubmit', { prompt: 'speed up the parser' }, at())
  assert.equal(
    (await hook('claude', 'Stop', {}, at())).json.systemMessage,
    '💡 7 shelved ideas fit what you just did: [1] parser idea0 · [2] parser idea1 · [3] parser idea2 · [4] parser idea3 · [5] parser idea4 · 2 more (/idea to list) (pick up: /idea send 1 2 3 4 5 or agent-mods idea take 1 2 3 4 5; mute: /idea dismiss 1 2 3 4 5)',
  )
})

test('Stop: when an earlier mod blocks, the nudge waits for the real end of the turn', async () => {
  const { env } = tempStore()
  const repo = makeRepo('blocked')
  const blocker = {
    name: 'blocker',
    hooks: {
      Stop: (ctx) => {
        if (!ctx.ev.stopHookActive) ctx.out.block = 'log your assumptions'
      },
    },
  }
  const at = () => ({ cwd: repo, env, mods: [blocker, ideas], now: Date.now() })
  await cli(env, 'idea', 'add', 'cache the parser output', '--cwd', repo)
  await tick()
  await hook('claude', 'UserPromptSubmit', { prompt: 'speed up the parser' }, at())
  assert.deepEqual((await hook('claude', 'Stop', {}, at())).json, { decision: 'block', reason: 'log your assumptions' })
  assert.match((await hook('claude', 'Stop', { stopHookActive: true }, at())).json.systemMessage, /1 shelved idea fits/)
  assert.equal((await hook('claude', 'Stop', { stopHookActive: true }, at())).raw, '')
})

test('turn topics: /idea prompts add none; a taken idea adds its own words, as the original sent prompt did', async () => {
  const { env, store } = tempStore()
  const repo = makeRepo('topics')
  const at = () => ({ cwd: repo, env, mods: [ideas], now: Date.now() })
  await cli(env, 'idea', 'add', 'list pagination for orders', '--cwd', repo)
  await tick()
  await hook('claude', 'UserPromptSubmit', { prompt: '/idea list' }, at())
  assert.equal((await hook('claude', 'Stop', {}, at())).raw, '')
  await hook('codex', 'UserPromptSubmit', { prompt: '$idea list' }, at())
  assert.equal((await hook('codex', 'Stop', {}, at())).raw, '')

  await cli(env, 'idea', 'rm', '1', '--cwd', repo)
  await cli(env, 'idea', 'add', 'cache the parser output', '--cwd', repo)
  await cli(env, 'idea', 'add', 'parser errors need line numbers', '--cwd', repo)
  const claude = await agentClient('claude', env, store, repo)
  await tick()
  await hook('claude', 'UserPromptSubmit', { prompt: '/idea send 1' }, at())
  assert.equal((await claude.tool('ideas', { action: 'take', ids: ['1'], cwd: repo })).data.prompt, 'cache the parser output')
  const stop = await hook('claude', 'Stop', {}, at())
  assert.equal(stop.json.systemMessage, '💡 1 shelved idea fits what you just did: [1] parser errors need line numbers (pick up: /idea send 1 or agent-mods idea take 1; mute: /idea dismiss 1)')
  assert.deepEqual(shelfOf(store, repo).map((i) => i.text), ['parser errors need line numbers'])
  claude.close()
})

test('CLI: list, add, take, rm, restore, --json, --include-taken, --all-projects, alias, usage errors', async () => {
  const { env } = tempStore()
  const alpha = makeRepo('alpha')
  const beta = makeRepo('beta')
  assert.equal((await cli(env, 'idea', '--cwd', alpha)).out, 'No shelved ideas in alpha. Add one with: agent-mods idea add <text>\n')
  await cli(env, 'idea', 'add', 'cache the parser output', '--cwd', alpha)
  await cli(env, 'idea', 'add', 'rename the logo asset', '--cwd', alpha)
  await cli(env, 'idea', 'add', 'beta has its own shelf', '--cwd', beta)
  assert.equal((await cli(env, 'idea', 'add', 'Cache the parser outputs', '--cwd', alpha)).out, 'Already shelved: cache the parser output\n')

  const listing = 'alpha: 2 shelved ideas\n  1. cache the parser output  (you, just now)\n  2. rename the logo asset  (you, just now)\n'
  assert.equal((await cli(env, 'idea', 'list', '--cwd', alpha)).out, listing)
  assert.equal((await cli(env, 'ideas', '--cwd', alpha)).out, listing)
  const json = JSON.parse((await cli(env, 'idea', 'list', '--json', '--cwd', alpha)).out)
  assert.equal(json.project, 'alpha')
  assert.deepEqual(json.ideas.map((i) => [i.n, i.text, i.source, i.status]), [[1, 'cache the parser output', 'you', 'open'], [2, 'rename the logo asset', 'you', 'open']])

  const both = await cli(env, 'idea', 'take', '1', '2', '--cwd', alpha)
  assert.equal(both.out, 'Shelved ideas to pick up:\n- cache the parser output\n- rename the logo asset\n')
  assert.match((await cli(env, 'idea', 'list', '--include-taken', '--cwd', alpha)).out, /^alpha: 0 shelved ideas, 2 taken\n {2}1\. cache the parser output {2}\(you, just now; taken by you just now\)/)
  const again = await cli(env, 'idea', 'take', '1', '--cwd', alpha)
  assert.equal(again.code, 1)
  assert.equal(again.err, 'Not available: 1 (taken by you just now)\n')
  assert.equal((await cli(env, 'idea', 'restore', '1', '2', '--cwd', alpha)).out, 'Restored: cache the parser output\nRestored: rename the logo asset\n')
  assert.equal((await cli(env, 'idea', 'rm', '2', '--cwd', alpha)).out, 'Removed: rename the logo asset\n')
  const gone = await cli(env, 'idea', 'rm', '9', '--cwd', alpha)
  assert.equal(gone.code, 1)
  assert.equal(gone.err, 'Not available: 9 (not on the shelf)\n')

  const all = (await cli(env, 'idea', 'list', '--all-projects')).out
  assert.match(all, /alpha \(.+\/alpha\): 1 shelved idea\n {2}1\. cache the parser output/)
  assert.match(all, /beta \(.+\/beta\): 1 shelved idea\n {2}1\. beta has its own shelf/)
  const allJson = JSON.parse((await cli(env, 'idea', 'list', '--all-projects', '--json')).out)
  assert.deepEqual(allJson.projects.map((p) => p.project).sort(), ['alpha', 'beta'])

  assert.equal((await cli(env, 'idea', 'add', '--cwd', alpha)).code, 2)
  assert.equal((await cli(env, 'idea', 'add', 'y'.repeat(301), '--cwd', alpha)).code, 2)
  assert.equal((await cli(env, 'idea', 'take', '--cwd', alpha)).code, 2)
  const unknown = await cli(env, 'idea', 'frobnicate', '--cwd', alpha)
  assert.equal(unknown.code, 2)
  assert.match(unknown.err, /^Unknown idea command: frobnicate/)
  const help = await cli(env, 'idea', '--help')
  assert.equal(help.code, 0)
  assert.match(help.out, /agent-mods idea take <n\|id>\.\.\./)
})
