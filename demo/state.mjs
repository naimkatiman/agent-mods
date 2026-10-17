// Fixed sample content only. No files, agent connections, network calls or credentials.
const LABELS = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok', devin: 'Devin' }
const HATS = ['tophat', 'party', 'crown', 'wizard', 'cowboy', 'propeller', 'chef', 'viking', 'halo', 'santa', 'nightcap']
const clone = value => structuredClone(value)
const reply = (text, data) => ({ status: 200, ok: true, text, ...(data === undefined ? {} : { data: clone(data) }) })
const fail = (status, text) => ({ status, ok: false, text })
const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim() : ''

export function createDemoState(now = Date.now()) {
  const projects = [
    { id: 'demo-studio', name: 'Studio Notes', topic: 'Onboarding', choice: 'Warm paper, quiet typography' },
    { id: 'demo-guide', name: 'Field Guide', topic: 'Reading view', choice: 'A focused, single-column layout' },
  ].map((p, index) => ({
    id: p.id, name: p.name, path: `demo://projects/${p.id}`, actionable: true, live: 2,
    ideas: [
      { id: `${now - 600000}-sample${index}`, text: index ? 'Add a saved reading list' : 'Offer a keyboard shortcut cheat sheet', source: 'you', createdAt: now - 600000, status: 'open', files: ['src/shortcuts.ts'], takenBy: null },
      { id: `${now - 900000}-taken${index}`, text: index ? 'Keep search filters between visits' : 'Remember the last open note', source: 'codex', createdAt: now - 900000, status: 'taken', files: ['src/preferences.ts'], takenBy: { agent: 'codex', agentLabel: 'Codex', at: now - 120000 } },
    ],
    assumptions: [
      { id: 1, text: index ? 'Search should include archived entries.' : 'Draft notes should sync to a shared account.', context: 'Sample product choice awaiting your correction.', agent: 'claude', at: now - 180000 },
      { id: 2, text: 'Keyboard navigation should work without a mouse.', context: 'Sample accessibility requirement.', agent: 'codex', at: now - 300000 },
    ],
    rules: [{ id: 1, assumption: 'Reload the page after changing preferences.', correction: 'Apply preferences immediately and preserve the current draft.', at: now - 1200000 }],
    decisions: [{ question: `Which direction suits the ${p.topic.toLowerCase()}?`, topic: p.topic, choice: p.choice, description: 'A sample decision remembered across every agent in this project.', agent: 'claude', at: now - 1500000 }],
  }))
  const work = [
    ['claude', 0, 'Welcome message', 'waiting', 'Choose the welcome message', 'Drafted two short welcome messages', 'Waiting for your copy choice', 'Apply the chosen wording', 'tophat'],
    ['codex', 0, 'Reading position', 'working', null, 'Saved the last open note', 'Restoring your place after reload', 'Check keyboard navigation', 'wizard'],
    ['grok', 1, 'Search and filters', 'working', null, 'Added tags and search', 'Checking empty search states', 'Review the filter labels', 'propeller'],
    ['devin', 1, 'Mobile reading view', 'idle', null, 'Finished a cleaner mobile layout', null, 'Ready for your review', 'crown'],
  ]
  const sessions = work.map(([agent, projectIndex, name, state, waitingFor, done, doing, next, hat], index) => {
    const p = projects[projectIndex], id = `demo-${agent}-session`
    const taskList = [
      { text: 'Review the sample brief', status: 'completed' },
      { text: done, status: 'completed' },
      { text: state === 'idle' ? 'Check the sample on mobile' : doing, status: state === 'idle' ? 'completed' : 'in_progress' },
      { text: next, status: state === 'idle' ? 'completed' : 'pending' },
    ]
    return {
      key: `${agent}__${id}`, agent, agentLabel: LABELS[agent], id, name, state, alive: true, native: false,
      waitingFor, since: now - (index === 3 ? 25000 : 90000 + index * 10000), startedAt: now - 2400000,
      turns: 8 + index, done, doing, next, tasks: { total: 4, done: state === 'idle' ? 4 : 2 }, taskList,
      files: index < 2 ? ['src/onboarding/copy.ts', 'src/preferences.ts'] : ['src/search.ts', 'src/reading-view.css'],
      lastEditAt: now - 45000, cwd: p.path, project: p.name, projectId: p.id, worktree: p.path, home: null,
      prompt: `Sample brief: improve ${name.toLowerCase()} and keep the current draft.`,
      answer: state === 'idle' ? 'Sample changes are ready. The mobile layout and keyboard checks pass.' : 'Sample progress is recorded here so every agent can see the next step.',
      unread: 0, hat, canResume: true,
    }
  })
  const briefs = Object.fromEntries(sessions.map((s, index) => [s.key, {
    firstPrompt: `${s.prompt}\nWork only in this fictional project. Explain the result and leave the next step clear.`,
    truncated: false, context: { used: 42000 + index * 8000, window: 200000, percent: 21 + index * 4, compactions: index === 1 ? 1 : 0 },
    contextText: `Sample context: ${42 + index * 8},000 / 200,000 tokens (${21 + index * 4}%).`,
    suggestion: `Continue the sample ${s.name.toLowerCase()} task. Already done: ${s.done}. Next: ${s.next}.`,
  }]))
  const activity = sessions.map((s, index) => ({ t: now - 90000 + index * 15000, ev: s.state === 'waiting' ? 'notify' : s.state === 'idle' ? 'turn.stop' : 'tool.post', key: s.key, agent: s.agent, agentLabel: s.agentLabel, projectId: s.projectId, project: s.project, kind: 'edit', label: s.files[0], hat: s.hat, ok: true }))
  const snapshot = {
    v: 1, at: now, demo: true, sessions, projects,
    clashes: [{ file: 'src/onboarding/copy.ts', worktree: projects[0].path, edits: sessions.slice(0, 2).map(s => ({ key: s.key, agent: s.agent, agentLabel: s.agentLabel, name: s.name, at: now - 45000 })) }],
    settings: { plain: { level: 'off', terms: ['Git', 'pull request'] }, notify: { enabled: false, afterMs: 30000, sound: true }, clawd: { hat: null, shades: false, hidden: false }, mods: Object.fromEntries(['sessions', 'assumptions', 'ideas', 'design', 'plain', 'enhance', 'clawd'].map(name => [name, true])) },
    health: { agents: sessions.map(s => ({ agent: s.agent, label: s.agentLabel, lastSeen: now - 30000, live: 1 })), errors: { count: 0, lastAt: null, last: null }, store: 'Browser-local sample data', server: null },
  }
  return { snapshot, activity, briefs, nextId: 1 }
}

export function demoSnapshot(state, now = Date.now()) {
  const snapshot = clone(state.snapshot), sessions = snapshot.sessions
  snapshot.at = now
  const count = status => sessions.filter(s => s.state === status).length
  snapshot.counts = { needsYou: count('waiting'), working: count('working'), done: count('idle'), open: count('open'), running: sessions.filter(s => s.state !== 'ended').length }
  for (const p of snapshot.projects) {
    p.ideas = p.ideas.filter(i => i.status !== 'dismissed')
    p.ideasCount = p.ideas.length
    p.openAssumptions = p.assumptions.length
  }
  return snapshot
}

export function demoBrief(state, key) {
  return state.briefs[key] ? { status: 200, ok: true, ...clone(state.briefs[key]) } : fail(404, 'No such sample session.')
}

export function demoResume(state, key, shell = 'powershell') {
  if (!state.snapshot.sessions.some(s => s.key === key)) return fail(404, 'No such sample session.')
  if (!['powershell', 'bash', 'cmd'].includes(shell)) return fail(400, 'Choose PowerShell, Bash or cmd.')
  return { status: 200, ok: true, command: 'echo "Demo only: no real agent session is connected."', note: null }
}

export function demoAction(state, body, { now = Date.now() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Choose a demo action.')
  const { type } = body, snapshot = state.snapshot
  const session = snapshot.sessions.find(s => s.key === body.key)
  const project = snapshot.projects.find(p => p.id === body.projectId)
  if (typeof type !== 'string') return fail(400, 'An action needs a type.')
  if (type.startsWith('idea.') || ['assumption.verdict', 'rule.delete'].includes(type)) {
    if (!project) return fail(404, 'No such sample project.')
  }
  if (type === 'assumption.verdict') {
    if (!['right', 'wrong'].includes(body.verdict)) return fail(400, 'Choose right or wrong.')
    if (body.fix !== undefined && (typeof body.fix !== 'string' || body.fix.length > 500)) return fail(400, 'A correction takes at most 500 characters.')
    const item = project.assumptions.find(a => a.id === body.id)
    if (!item) return fail(404, 'That sample assumption is already resolved.')
    const fix = body.verdict === 'wrong' ? clean(body.fix) : ''
    let rule = null
    if (fix) {
      const id = Math.max(0, ...project.rules.map(r => r.id)) + 1
      project.rules.push({ id, assumption: item.text, correction: fix, at: now })
      rule = { kind: 'added', id }
    }
    project.assumptions = project.assumptions.filter(a => a.id !== body.id)
    return reply(`Sample assumption marked ${body.verdict}.${fix ? ' Your correction is now a rule in this browser.' : ''}`, { item: { id: item.id, verdict: body.verdict, note: fix || null }, rule })
  }
  if (type === 'rule.delete') {
    const index = project.rules.findIndex(r => r.id === body.id)
    if (index < 0) return fail(404, 'No such sample rule.')
    project.rules.splice(index, 1)
    return reply('Sample rule deleted in this browser.', { deleted: body.id })
  }
  if (type === 'idea.add') {
    const text = clean(body.text)
    if (!text || text.length > 300) return fail(400, 'An idea takes 1 to 300 characters.')
    const duplicate = project.ideas.find(i => i.text.toLowerCase() === text.toLowerCase() && i.status !== 'dismissed')
    if (duplicate) return reply('Already on the sample shelf.', { id: duplicate.id, duplicate: true })
    const id = `${now}-sample${state.nextId++}`
    project.ideas.unshift({ id, text, source: 'you', createdAt: now, status: 'open', files: [], takenBy: null })
    return reply('Idea shelved in this browser.', { id, duplicate: false })
  }
  if (['idea.prompt', 'idea.take', 'idea.restore', 'idea.dismiss', 'idea.remove'].includes(type)) {
    const idea = project.ideas.find(i => i.id === body.id)
    if (!idea) return fail(404, 'No such sample idea.')
    if (type === 'idea.prompt') return reply(idea.text, { prompt: idea.text })
    if (type === 'idea.restore' && !['taken', 'dismissed'].includes(idea.status)) return fail(409, 'That sample idea is already open.')
    if (type === 'idea.take' && idea.status !== 'open') return fail(409, 'That sample idea is not open.')
    if (type === 'idea.remove') project.ideas = project.ideas.filter(i => i.id !== body.id)
    else {
      idea.status = type === 'idea.take' ? 'taken' : type === 'idea.dismiss' ? 'dismissed' : 'open'
      idea.takenBy = idea.status === 'taken' ? { agent: 'codex', agentLabel: 'Codex (sample)', at: now } : null
    }
    return reply('Sample shelf updated in this browser.')
  }
  if (type === 'plain') {
    if (!['off', 'beginner', 'expert'].includes(body.level)) return fail(400, 'Choose off, beginner or expert.')
    snapshot.settings.plain.level = body.level
    return reply('Sample answer style saved in this browser.', snapshot.settings.plain)
  }
  if (type === 'notify') {
    if (typeof body.enabled !== 'boolean') return fail(400, 'Alert preference must be true or false.')
    snapshot.settings.notify.enabled = body.enabled
    return reply('Sample finish-alert preference saved in this browser.', snapshot.settings.notify)
  }
  if (type === 'clawd') {
    if (!['hat', 'shades', 'show', 'hide', 'pet', 'dance', 'party'].includes(body.verb)) return fail(400, 'Choose a supported pet action.')
    if (body.key && !session) return fail(404, 'No such sample session.')
    if (body.verb === 'hat' && body.arg !== 'random' && !HATS.includes(body.arg)) return fail(400, 'Choose a hat from the sample gallery.')
    const prefs = session ? (session.petPrefs ??= { ...snapshot.settings.clawd, hat: session.hat }) : snapshot.settings.clawd
    if (body.verb === 'hat') prefs.hat = body.arg === 'random' ? null : body.arg
    if (body.verb === 'shades') prefs.shades = !prefs.shades
    if (['show', 'hide'].includes(body.verb)) prefs.hidden = body.verb === 'hide'
    if (session && body.verb === 'hat') session.hat = prefs.hat
    if (!session && body.verb === 'hat') for (const s of snapshot.sessions) {
      s.hat = prefs.hat
      if (s.petPrefs) s.petPrefs.hat = prefs.hat
    }
    const hat = prefs.hat ?? session?.hat ?? 'tophat'
    state.activity.push({ t: now, ev: 'clawd.cmd', key: session?.key ?? null, projectId: session?.projectId ?? null, project: session?.project ?? '', agent: 'dashboard', agentLabel: 'Demo', verb: body.verb, arg: body.arg ?? '', hat, shades: prefs.shades, hidden: prefs.hidden, ok: true })
    state.activity = state.activity.slice(-100)
    return reply('Sample pet updated in this browser.', { hat, prefs })
  }
  if (['send', 'continue'].includes(type)) {
    if (!session) return fail(404, 'No such sample session.')
    const text = clean(body.text), limit = type === 'send' ? 500 : 2000
    if (!text || text.length > limit) return fail(400, `A sample message takes 1 to ${limit} characters.`)
    session.unread++
    return reply('Saved in this browser, demo only. No real agent receives this message.', { delivered: 'queued', demo: true })
  }
  return fail(400, 'That action is not available in this demo.')
}
