// ideas mod: the claude-mods idea-shelf for every agent. Park side ideas mid-task without acting on
// them: the user shelves with /idea (skill) or `agent-mods idea add`, agents shelve their own tangents
// with the shelve_idea tool, and after a turn a notice says when a shelved idea shares a keyword with
// the turn's prompt or edited files (plain word overlap, no model call). Shelf logic and storage live
// in ideas-shelf.mjs.
import { relativeTo } from '../core/project.mjs'
import { sessionState } from '../core/store.mjs'
import { clip, plural, sanitize } from '../core/text.mjs'
import {
  MAX_IDEAS,
  MAX_TEXT,
  TAKE_TTL_MS,
  addIdea,
  cleanFiles,
  cleanText,
  completeTakes,
  heldBy,
  ideaLine,
  ideaWords,
  missingText,
  normalizeShelf,
  ordered,
  pathWords,
  promptFor,
  publicIdea,
  readShelf,
  removeIdeas,
  resolveRefs,
  restoreIdeas,
  sourceFor,
  sourceLabel,
  takeIdeas,
  textProblem,
  toRefs,
  words,
} from './ideas-shelf.mjs'

const MOD = 'ideas'
// Four agents follow GUIDANCE on one repo; this keeps one session from flooding the shelf.
const SESSION_CAP = 10
// Topic lists live in a session file read and written on every edit; a pasted log must not bloat it.
const PROMPT_SCAN_CHARS = 20_000
const MAX_PROMPT_TOPICS = 200
const MAX_TOPICS = 400
const MAX_DISMISSED = 500
const MAX_NUDGE_ITEMS = 5
const NUDGE_TEXT_MAX = 80
const TAKE_TTL_TEXT = `${TAKE_TTL_MS / 3_600_000} h`
const ACTIONS = ['list', 'take', 'restore', 'remove', 'dismiss']
// /idea runs as a skill here, so its own prompt is a turn; its words are not what the turn worked on.
const IDEA_COMMAND = /^\s*[/$]ideas?\b/i

// How the user invokes the idea skill: Codex has no custom slash commands, only $skill mentions.
function ideaCommand(agent) {
  return agent === 'codex' ? '$idea' : '/idea'
}

// The original's system-prompt section (register.tsx:11-12), with this server's tool name.
export const GUIDANCE = `# Idea shelf
When you notice a tangent or side improvement that is not part of the current task (a refactor, a missing test, a cleanup, a follow-up feature), do not act on it mid-task. Call the agent-mods \`shelve_idea\` tool with a one-line description that names the files or area it concerns, then carry on with the task. The user reviews shelved ideas later.`

const SHELVE_DESCRIPTION =
  'Shelve a side idea or tangent for the user to review later, instead of acting on it now. ' +
  'Use for improvements noticed mid-task that are outside its scope. Name the files or area it concerns.'
const EMPTY_TEXT = 'shelve_idea needs a non-empty `text`.'
const LONG_TEXT = `shelve_idea needs \`text\` of at most ${MAX_TEXT} characters, on one line.`
const FAILED_TEXT = 'idea-shelf: could not shelve that idea.'
const CAP_TEXT = `This session has already shelved ${SESSION_CAP} ideas, the limit. Carry on with the task; mention any further side ideas in your final reply instead.`
const FULL_TEXT = `The idea shelf is full (${MAX_IDEAS} ideas). Mention the idea in your final reply instead; the user can clear the shelf with /idea drop.`
const EMPTY_SHELF = 'Shelf empty. Add with /idea <text>.'

const texts = (list) => list.map((idea) => idea.text).join(' · ')

// The order a session last saw numbers in (a list or a nudge), kept per project: '/idea send 2' means
// the 2 the user was shown, even if another session changed the shelf since.
function savedList(project, ideas) {
  return { projectId: project.projectId, ids: ideas.map((idea) => idea.id) }
}

function lastListFor(saved, project) {
  return saved?.lastList?.projectId === project.projectId ? saved.lastList.ids : null
}

function promptTopics(prompt) {
  const text = String(prompt ?? '')
  if (IDEA_COMMAND.test(text)) return []
  return [...new Set(words(text.slice(0, PROMPT_SCAN_CHARS)))].slice(0, MAX_PROMPT_TOPICS)
}

// The turn with extra topics, or null when nothing new was added (so callers can skip the write).
function withTopics(turn, extra) {
  const topics = new Set(turn.topics ?? [])
  const before = topics.size
  for (const word of extra) if (topics.size < MAX_TOPICS) topics.add(word)
  return topics.size === before ? null : { ...turn, topics: [...topics] }
}

// Open ideas from before this turn, not dismissed here, not shelved this turn, sharing a keyword with
// the turn's prompt or edited files (register.tsx:143-144, plus the turn-start cut-off). Numbered by
// their position in the open list, the same numbers `idea list` shows.
function fitting(shelf, state, now) {
  const turn = state.turn
  if (!turn?.topics?.length) return []
  const topics = new Set(turn.topics)
  const dismissed = new Set(state.dismissed ?? [])
  const mine = new Set(state.shelvedThisTurn ?? [])
  return ordered(shelf, now)
    .map((idea, i) => ({ idea, n: i + 1 }))
    .filter(({ idea }) =>
      idea.createdAt < turn.startedAt && !mine.has(idea.id) && !dismissed.has(idea.id) && ideaWords(idea).some((w) => topics.has(w)))
}

// The band (register.tsx:159-169) as one line: its label, the texts, and the Send/Dismiss buttons as
// commands.
function nudgeText(fits, agent) {
  const label = fits.length === 1 ? '1 shelved idea fits' : `${fits.length} shelved ideas fit`
  const first = fits.slice(0, MAX_NUDGE_ITEMS)
  const shown = first.map(({ idea, n }) => `[${n}] ${clip(idea.text, NUDGE_TEXT_MAX)}`)
  const cmd = ideaCommand(agent)
  if (fits.length > first.length) shown.push(`${fits.length - first.length} more (${cmd} to list)`)
  const nums = first.map(({ n }) => n).join(' ')
  return `💡 ${label} what you just did: ${shown.join(' · ')} (pick up: ${cmd} send ${nums} or agent-mods idea take ${nums}; mute: ${cmd} dismiss ${nums})`
}

const hooks = {
  SessionStart(ctx) {
    // The original put GUIDANCE in the system prompt wherever its tool was offered (register.tsx:98-102).
    ctx.out.context.push(GUIDANCE)
    if (ctx.ev.source === 'compact') return
    // A count for the user only: idea texts in model context would get acted on unasked.
    const open = ordered(readShelf(ctx.store, ctx.project), ctx.now).length
    if (open) ctx.out.notice.push(`💡 ${plural(open, 'shelved idea')} in this project (${ideaCommand(ctx.ev.agent)} to view)`)
  },

  UserPromptSubmit(ctx) {
    if (ctx.ev.isSubagent) return
    const turn = { startedAt: ctx.now, topics: promptTopics(ctx.ev.prompt) }
    ctx.session.state(MOD).update((cur) => ({ ...cur, turn, shelvedThisTurn: [] }), {})
  },

  // Subagent edits count, as in the original's tool.call wrapper. Paths are taken relative to the
  // worktree, so the repo's own folder name ('SampleApp') is not a topic of every root file.
  PostToolUse(ctx) {
    const { ev } = ctx
    if (!ev.edits.length || ev.toolFailed) return
    const found = ev.edits.flatMap((edit) => pathWords(relativeTo(ctx.project.worktreeKey, edit.path) ?? edit.path))
    if (!found.length) return
    ctx.session.state(MOD).update((cur) => {
      const turn = cur?.turn ? withTopics(cur.turn, found) : null
      return turn ? { ...cur, turn } : undefined
    }, {})
  },

  Stop(ctx) {
    const { ev } = ctx
    if (ev.isSubagent) return
    const state = ctx.session.state(MOD)
    const current = state.read({})
    const deferred = current.turn?.deferred === true
    if (ev.stopHookActive && !deferred) return
    if (ctx.out.block) {
      // An earlier mod keeps the agent working and a block reply carries no notice: finish at the real stop.
      if (current.turn && !deferred) state.update((cur) => (cur?.turn ? { ...cur, turn: { ...cur.turn, deferred: true } } : undefined), {})
      return
    }
    let shelf = readShelf(ctx.store, ctx.project)
    if (shelf.ideas.some((idea) => heldBy(idea, ctx.session.key, ctx.now))) {
      completeTakes(ctx.store, ctx.project, ctx.session.key, ctx.now)
      shelf = readShelf(ctx.store, ctx.project)
    }
    const fits = fitting(shelf, current, ctx.now)
    if (fits.length) ctx.out.notice.push(nudgeText(fits, ev.agent))
    if (!fits.length && !deferred) return
    state.update((cur) => {
      const next = { ...cur }
      if (cur?.turn) next.turn = { ...cur.turn, deferred: false }
      if (fits.length) next.lastList = savedList(ctx.project, ordered(shelf, ctx.now))
      return next
    }, {})
  },
}

function callerState(mctx, args, project) {
  const caller = mctx.caller(args, project)
  return { caller, state: caller ? sessionState(mctx.store, caller.key, MOD) : null }
}

function shelve(args, mctx) {
  const text = cleanText(args.text)
  const problem = textProblem(text)
  if (problem === 'empty') return { text: EMPTY_TEXT, isError: true }
  if (problem === 'long') return { text: LONG_TEXT, isError: true }
  const project = mctx.project(args.cwd)
  const asUser = args.as_user === true
  // The user's own /idea is neither capped nor this turn's agent idea.
  const { state } = asUser ? { state: null } : callerState(mctx, args, project)
  if (state && (state.read({}).shelvedCount ?? 0) >= SESSION_CAP) return { text: CAP_TEXT, isError: true }
  const source = asUser ? 'you' : sourceFor(mctx.agent)
  const result = addIdea(mctx.store, project, { text, files: cleanFiles(args.files), source, now: mctx.now })
  if (result.full) return { text: FULL_TEXT, isError: true }
  const { idea, duplicate } = result
  if (state) {
    // Not nudged back at the end of this turn (register.tsx:107); only new ideas count toward the cap.
    state.update((cur) => ({
      ...cur,
      shelvedThisTurn: [...new Set([...(cur?.shelvedThisTurn ?? []), idea.id])],
      shelvedCount: (cur?.shelvedCount ?? 0) + (duplicate ? 0 : 1),
    }), {})
  }
  const data = { id: idea.id, text: idea.text, source: idea.source, project: project.name, projectId: project.projectId, count: result.count }
  if (duplicate) return { text: `Already shelved for the user: ${idea.text}`, data: { ...data, duplicate_of: idea.id } }
  return { text: `Shelved for the user: ${idea.text}`, data }
}

function listIdeas(args, mctx, project, state) {
  const now = mctx.now
  const shelf = readShelf(mctx.store, project)
  const shown = ordered(shelf, now, args.include_taken === true)
  if (state) state.update((cur) => ({ ...cur, lastList: savedList(project, shown) }), {})
  const data = { project: project.name, projectId: project.projectId, ideas: shown.map((idea, i) => publicIdea(idea, now, i + 1)) }
  if (!shown.length) return { text: EMPTY_SHELF, data }
  const open = ordered(shelf, now).length
  const header =
    `Idea shelf for ${project.name}: ${plural(open, 'open idea')}. These are notes shelved by the user or by agent ` +
    'sessions for the user to pick from; do not act on them unless the user asks.'
  return { text: [header, ...shown.map((idea, i) => ideaLine(i + 1, idea, now))].join('\n'), data }
}

function take(refs, mctx, project, caller, state, lastList) {
  const now = mctx.now
  const result = takeIdeas(mctx.store, project, refs, {
    agent: caller?.agent ?? sourceFor(mctx.agent),
    sessionKey: caller?.key ?? null,
    now,
    lastList,
  })
  const prompt = result.taken.length ? promptFor(result.taken) : ''
  if (state && result.taken.length) {
    // The original sent ideas as the turn's prompt, so their words were the turn's topics.
    state.update((cur) => {
      const turn = cur?.turn ? withTopics(cur.turn, words(prompt)) : null
      return turn ? { ...cur, turn } : undefined
    }, {})
  }
  const lines = []
  if (result.taken.length) {
    const by = [...new Set(result.taken.map((idea) => sourceLabel(idea.source)))].join(', ')
    const them = result.taken.length === 1 ? 'it' : 'them'
    lines.push(`Took ${plural(result.taken.length, 'idea')} off the shelf (shelved by ${by}). If the user asked to pick ${them} up, carry this out as their request:`)
    lines.push('', prompt, '')
    lines.push(caller
      ? `${result.taken.length === 1 ? 'It leaves' : 'They leave'} the shelf when this turn ends; the \`ideas\` restore action puts ${them} back.`
      : `${result.taken.length === 1 ? 'It returns' : 'They return'} to the shelf in ${TAKE_TTL_TEXT} unless removed with the \`ideas\` remove action.`)
  }
  if (result.missing.length) lines.push(`Not available: ${missingText(result.missing)}.`)
  return {
    text: lines.join('\n'),
    data: { prompt, taken: result.taken.map((idea) => publicIdea(idea, now)), missing: result.missing.map((m) => m.ref) },
    isError: !result.taken.length,
  }
}

function dismiss(refs, mctx, project, state, lastList) {
  if (!state) {
    return { text: 'Could not tell which session is calling, so there is no session to mute these ideas in.', isError: true }
  }
  const shelf = readShelf(mctx.store, project)
  const known = []
  const missing = []
  for (const { ref, id } of resolveRefs(refs, shelf, mctx.now, lastList)) {
    const idea = shelf.ideas.find((one) => one.id === id)
    if (idea) known.push(idea)
    else missing.push({ ref, reason: 'not on the shelf' })
  }
  if (known.length) {
    state.update((cur) => ({
      ...cur,
      dismissed: [...new Set([...(cur?.dismissed ?? []), ...known.map((idea) => idea.id)])].slice(-MAX_DISMISSED),
    }), {})
  }
  const lines = known.length ? [`Dismissed for the rest of this session (no more nudges): ${texts(known)}`] : []
  if (missing.length) lines.push(`Not available: ${missingText(missing)}.`)
  return { text: lines.join('\n'), data: { dismissed: known.map((idea) => idea.id), missing: missing.map((m) => m.ref) }, isError: !known.length }
}

function manage(args, mctx) {
  const action = args.action ?? 'list'
  if (!ACTIONS.includes(action)) return { text: `Unknown action "${action}". Use one of: ${ACTIONS.join(', ')}.`, isError: true }
  const project = mctx.project(args.cwd)
  const { caller, state } = callerState(mctx, args, project)
  if (action === 'list') return listIdeas(args, mctx, project, state)
  const refs = toRefs(args.ids)
  if (!refs.length) return { text: `ideas ${action} needs \`ids\`: idea ids, or numbers from the list.`, isError: true }
  const lastList = lastListFor(state?.read({}), project)
  if (action === 'take') return take(refs, mctx, project, caller, state, lastList)
  if (action === 'dismiss') return dismiss(refs, mctx, project, state, lastList)
  const now = mctx.now
  const verb = action === 'restore' ? 'Restored' : 'Removed'
  const result = action === 'restore'
    ? restoreIdeas(mctx.store, project, refs, { now, lastList })
    : removeIdeas(mctx.store, project, refs, { now, lastList })
  const done = action === 'restore' ? result.restored : result.removed
  const lines = done.length ? [`${verb} ${plural(done.length, 'idea')}: ${texts(done)}`] : []
  if (result.missing.length) lines.push(`Not available: ${missingText(result.missing)}.`)
  const key = action === 'restore' ? 'restored' : 'removed'
  return { text: lines.join('\n'), data: { [key]: done.map((idea) => idea.id), missing: result.missing.map((m) => m.ref) }, isError: !done.length }
}

const tools = [
  {
    name: 'shelve_idea',
    description: SHELVE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The idea, one line' },
        files: { type: 'array', items: { type: 'string' }, description: 'Files it concerns' },
        as_user: { type: 'boolean', description: 'Only for /idea <text>: the user is shelving it' },
        cwd: { type: 'string', description: 'Your working directory' },
      },
      required: ['text'],
    },
    run(args, mctx) {
      try {
        return shelve(args, mctx)
      } catch (err) {
        mctx.log(`ideas.shelve_idea: ${err?.stack ?? err}`)
        return { text: FAILED_TEXT, isError: true }
      }
    },
  },
  {
    name: 'ideas',
    description:
      "This project's idea shelf: list it, or take (claim ideas and get their prompt), restore, remove or dismiss ideas. " +
      'Take only when the user asks to pick ideas up.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'Default list' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Idea ids, or numbers from the last list ("2")' },
        include_taken: { type: 'boolean', description: 'list: also show ideas being worked on' },
        cwd: { type: 'string', description: 'Your working directory' },
      },
    },
    run: manage,
  },
]

const USAGE = [
  'Usage: agent-mods idea [list] [--include-taken] [--all-projects] [--json]',
  '       agent-mods idea add <text...>',
  '       agent-mods idea take <n|id>...      print the prompt and mark the ideas taken',
  '       agent-mods idea rm <n|id>...',
  '       agent-mods idea restore <n|id>...',
  'Numbers are positions in `agent-mods idea list --include-taken` (open ideas first). --cwd <dir> picks another project.',
].join('\n')

function printList(c, title, shelf, shown) {
  const open = ordered(shelf, c.now).length
  const taken = shown.length - Math.min(open, shown.length)
  c.print(`${title}: ${plural(open, 'shelved idea')}${taken ? `, ${taken} taken` : ''}`)
  shown.forEach((idea, i) => c.print(`  ${ideaLine(i + 1, idea, c.now)}`))
}

function cliList(c) {
  const includeTaken = c.flags['include-taken'] === true
  if (c.flags['all-projects'] === true) {
    const groups = []
    for (const entry of c.store.list('projects')) {
      if (!entry.isDirectory()) continue
      const shelf = normalizeShelf(c.store.readJson(`projects/${entry.name}/ideas.json`, null))
      const shown = ordered(shelf, c.now, includeTaken)
      if (!shown.length) continue
      const meta = c.store.readJson(`projects/${entry.name}/meta.json`, null) ?? {}
      groups.push({ project: meta.name ?? entry.name, projectId: entry.name, repoKey: meta.repoKey ?? null, shelf, shown })
    }
    if (c.json) {
      c.printJson({
        projects: groups.map((g) => ({ project: g.project, projectId: g.projectId, repoKey: g.repoKey, ideas: g.shown.map((idea, i) => publicIdea(idea, c.now, i + 1)) })),
      })
      return 0
    }
    if (!groups.length) c.print('No shelved ideas in any project.')
    groups.forEach((g, i) => {
      if (i) c.print('')
      // Project names and paths come from meta.json, which any session's cwd can shape.
      printList(c, sanitize(`${g.project}${g.repoKey ? ` (${g.repoKey})` : ''}`, 300), g.shelf, g.shown)
    })
    return 0
  }
  const shelf = readShelf(c.store, c.project)
  const shown = ordered(shelf, c.now, includeTaken)
  if (c.json) {
    c.printJson({
      project: c.project.name,
      projectId: c.project.projectId,
      repoKey: c.project.repoKey,
      ideas: shown.map((idea, i) => publicIdea(idea, c.now, i + 1)),
    })
    return 0
  }
  if (!shown.length) c.print(`No shelved ideas in ${c.project.name}. Add one with: agent-mods idea add <text>`)
  else printList(c, c.project.name, shelf, shown)
  return 0
}

function cliAdd(c, rest) {
  const text = cleanText(rest.join(' '))
  const problem = textProblem(text)
  if (problem) {
    c.error(problem === 'empty' ? 'Usage: agent-mods idea add <text...>' : `An idea is one line of at most ${MAX_TEXT} characters.`)
    return 2
  }
  const result = addIdea(c.store, c.project, { text, source: 'you', now: c.now })
  if (result.full) {
    c.error(`The idea shelf for ${c.project.name} is full (${MAX_IDEAS} ideas). Remove some with: agent-mods idea rm <n>`)
    return 1
  }
  if (c.json) c.printJson({ id: result.idea.id, text: result.idea.text, duplicate_of: result.duplicate ? result.idea.id : undefined })
  else c.print(result.duplicate ? `Already shelved: ${result.idea.text}` : `Shelved: ${result.idea.text}`)
  return 0
}

function cliTake(c, refs) {
  const result = takeIdeas(c.store, c.project, refs, { agent: 'you', sessionKey: null, now: c.now })
  const prompt = result.taken.length ? promptFor(result.taken) : ''
  if (c.json) {
    c.printJson({ prompt, taken: result.taken.map((idea) => publicIdea(idea, c.now)), missing: result.missing.map((m) => m.ref) })
  } else {
    // stdout carries only the prompt, so `codex "$(agent-mods idea take 2)"` works; the rest goes to stderr.
    if (prompt) c.print(prompt)
    if (result.missing.length) c.error(`Not available: ${missingText(result.missing)}`)
    if (result.taken.length) {
      const ids = result.taken.map((idea) => idea.id).join(' ')
      c.error(`Marked taken. Back on the shelf in ${TAKE_TTL_TEXT} unless removed: agent-mods idea rm ${ids}`)
    }
  }
  return result.taken.length ? 0 : 1
}

function cliChange(c, refs, action) {
  const result = action === 'restore'
    ? restoreIdeas(c.store, c.project, refs, { now: c.now })
    : removeIdeas(c.store, c.project, refs, { now: c.now })
  const done = action === 'restore' ? result.restored : result.removed
  if (c.json) {
    c.printJson({ [action === 'restore' ? 'restored' : 'removed']: done.map((idea) => idea.id), missing: result.missing.map((m) => m.ref) })
  } else {
    for (const idea of done) c.print(`${action === 'restore' ? 'Restored' : 'Removed'}: ${idea.text}`)
    if (result.missing.length) c.error(`Not available: ${missingText(result.missing)}`)
  }
  return done.length ? 0 : 1
}

const cli = [
  {
    name: 'idea',
    aliases: ['ideas'],
    summary: 'Idea shelf: list | add <text> | take <n|id> | rm <n|id> | restore <n|id>',
    usage: USAGE,
    run(c) {
      const [sub = 'list', ...rest] = c.positionals
      if (sub === 'list' || sub === 'ls') return cliList(c)
      if (sub === 'add') return cliAdd(c, rest)
      const refs = toRefs(rest)
      if (!['take', 'rm', 'remove', 'restore'].includes(sub)) {
        c.error(`Unknown idea command: ${sub}\n\n${USAGE}`)
        return 2
      }
      if (!refs.length) {
        c.error(USAGE)
        return 2
      }
      if (sub === 'take') return cliTake(c, refs)
      return cliChange(c, refs, sub === 'restore' ? 'restore' : 'remove')
    },
  },
]

export default { name: MOD, hooks, tools, cli, briefing: () => GUIDANCE }
