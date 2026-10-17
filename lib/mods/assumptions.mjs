// assumptions mod: claude-mods' assumption-tracker for every agent. Agents log the assumptions they
// make with log_assumption; the user marks them right or wrong (CLI, skill, or the assumptions tool on
// the user's word); each verdict goes back to the session that logged it; a correction becomes a rule
// that every later session of every agent in the repo, in any worktree, gets at start.
//
// Store: projects/<projectId>/assumptions.json = { v, lastId, items, rules }, one file per repo,
// always changed under its lock (four agents write it). Session state: { rulesSig, startedAt }.
import { canInjectContext } from '../core/agents.mjs'
import { readRecord } from '../core/session-records.mjs'
import { projectFile, touchProjectMeta } from '../core/store.mjs'
import { plural } from '../core/text.mjs'
import {
  FILE,
  GUIDANCE,
  MAX_TEXT,
  STATUS,
  bandLabel,
  changeText,
  cleanText,
  clearReviewed,
  emptyDoc,
  hasDue,
  hasUnsentWrong,
  injectedRules,
  loggedBy,
  newestOpen,
  normalizeDoc,
  parseId,
  prune,
  renderList,
  ruleChange,
  ruleEffect,
  ruleRow,
  rulesChangedText,
  rulesSig,
  rulesText,
  setVerdict,
  statsText,
  takeFeedback,
  whoLabel,
} from './assumptions-logic.mjs'

const NAME = 'assumptions'

function readDoc(store, project) {
  return normalizeDoc(store.readJson(projectFile(project, FILE), null))
}

// Locked read-modify-write of the repo's file. fn gets the current doc and returns { doc, result };
// without a doc nothing is written. Fixes the original's unlocked get-then-set (register.tsx:74-79).
function changeDoc(store, project, now, fn) {
  let result
  store.update(projectFile(project, FILE), emptyDoc(), (current) => {
    const out = fn(normalizeDoc(current)) ?? {}
    result = out.result
    return out.doc ? { ...out.doc, items: prune(out.doc.items, now) } : undefined
  })
  return result
}

// This session's reviewed, unsent verdicts as one message, marked sent in the same locked write.
// The unlocked peek keeps the hot path (every edit, in four agents) to one small read.
function takeDue(ctx, { onlyIfWrong = false } = {}) {
  const key = ctx.session.key
  const ready = (items) => (onlyIfWrong ? hasUnsentWrong(items) : hasDue(items))
  if (!ready(readDoc(ctx.store, ctx.project).items.filter(loggedBy(key)))) return null
  return changeDoc(ctx.store, ctx.project, ctx.now, (doc) => {
    if (!ready(doc.items.filter(loggedBy(key)))) return null
    const taken = takeFeedback(doc.items, key)
    return taken.text ? { doc: { ...doc, items: taken.items }, result: taken.text } : null
  })
}

function briefing(ctx, rules) {
  ctx.out.context.push(GUIDANCE)
  const learned = injectedRules(rules)
  if (learned) ctx.out.context.push(learned)
}

// Subagent events are skipped throughout: verdicts belong to the main session's turn, and a
// subagent's context is gone when it returns.
const hooks = {
  SessionStart(ctx) {
    if (ctx.ev.isSubagent) return
    const { rules } = readDoc(ctx.store, ctx.project)
    briefing(ctx, rules)
    ctx.session.state(NAME).update((cur) => ({ ...cur, rulesSig: rulesSig(rules), startedAt: ctx.now }), {})
  },

  // Replaces the original's $.prompt.submit into an idle session: no agent here lets another
  // process start a turn, so a verdict given while idle goes out with the next prompt.
  UserPromptSubmit(ctx) {
    if (ctx.ev.isSubagent) return
    const state = ctx.session.state(NAME)
    const seen = state.read({})
    const { rules } = readDoc(ctx.store, ctx.project)
    const sig = rulesSig(rules)
    // No SessionStart reached this mod (a session older than the install): brief it now.
    if (typeof seen.rulesSig !== 'string') briefing(ctx, rules)
    else if (seen.rulesSig !== sig) ctx.out.context.push(rulesChangedText(rules))
    if (seen.rulesSig !== sig) state.update((cur) => ({ ...cur, rulesSig: sig }), {})
    // Grok cannot take context here. Its verdicts stay unsent for PostToolUse or the Stop block,
    // instead of sitting in the runtime queue already marked sent.
    if (!canInjectContext(ctx.ev.agent, ctx.ev.event)) return
    const text = takeDue(ctx)
    if (text) ctx.out.context.push(text)
  },

  // Mid-turn: verdicts ride along with the next tool result (register.tsx:173-179). Registered for
  // edit and todo tools only.
  PostToolUse(ctx) {
    if (ctx.ev.isSubagent) return
    const text = takeDue(ctx)
    if (text) ctx.out.context.push(text)
  },

  // Only an unsent WRONG verdict holds the turn open; everything due is marked sent before the block
  // goes out, so the next Stop passes (register.tsx:182-188).
  Stop(ctx) {
    if (ctx.ev.stopHookActive || ctx.ev.isSubagent || ctx.out.block) return
    const text = takeDue(ctx, { onlyIfWrong: true })
    if (text) ctx.out.block = text
  },
}

// Without a cwd the server's default directory is a guess; the caller's session record knows where
// that session works.
function target(args, mctx) {
  const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd : undefined
  let project = mctx.project(cwd)
  const caller = mctx.caller(args, project)
  if (!cwd && caller?.record?.cwd) project = mctx.project(caller.record.cwd)
  return { project, caller }
}

// judge (register.tsx:92-99) against the store, in one locked write. by is the rule provenance
// ('user' from the CLI and the dashboard, the calling session from MCP). takeFor, when set, also
// hands that caller its own due verdicts, which then include this one if it reviewed its own
// assumption. Exported, with verdictReport and deleteRule, so the dashboard takes the CLI's path.
export function judgeItem(store, project, now, { id, newest = false, verdict, correction, by, takeFor }) {
  return changeDoc(store, project, now, (doc) => {
    const found = newest ? newestOpen(doc.items) : doc.items.find((a) => a.id === id)
    if (!found) {
      return { result: { error: newest ? `No open assumptions in ${project.name}.` : `No assumption #${id} in ${project.name}.` } }
    }
    // The pane's Wrong button kept the earlier note, a typed correction replaced it, Right cleared it.
    const note = verdict === 'wrong' ? correction || found.note : undefined
    let { items } = setVerdict(doc.items, found.id, verdict, note, now)
    const rules = ruleEffect(doc.rules, found.text, verdict, note, { by, at: now })
    let feedback = null
    if (takeFor !== undefined) ({ text: feedback, items } = takeFeedback(items, takeFor))
    return {
      doc: { ...doc, items, rules },
      result: { item: items.find((a) => a.id === found.id), change: ruleChange(doc.rules, rules), feedback },
    }
  })
}

function deliveryText(store, item) {
  if (item.isSent) return null
  if (!item.sessionKey) {
    return 'No session is linked to it, so it waits until an agent asks for feedback (the agent-mods `assumptions` tool, action feedback).'
  }
  const who = whoLabel(item.agent, item.sessionKey)
  if (readRecord(store, item.sessionKey)?.endedAt) return `${who} has ended, so this verdict will not reach it.`
  return item.verdict === 'wrong'
    ? `It reaches ${who} with its next prompt or edit, or when it tries to stop.`
    : `It reaches ${who} with its next prompt or edit.`
}

export function verdictReport(store, { item, change, feedback }) {
  const lines = [`#${item.id} "${item.text}" marked ${item.verdict}${item.verdict === 'wrong' && item.note ? `: ${item.note}` : ''}.`]
  if (change) lines.push(changeText(change))
  else if (item.verdict === 'wrong' && !item.note) lines.push('No rule made: no correction given.')
  const delivery = deliveryText(store, item)
  if (delivery) lines.push(delivery)
  if (feedback) lines.push('', feedback)
  return lines.join('\n')
}

export function deleteRule(store, project, now, id) {
  return changeDoc(store, project, now, (doc) => {
    const rule = doc.rules.find((r) => r.id === id)
    if (!rule) return null
    const rules = doc.rules.filter((r) => r.id !== id)
    return { doc: { ...doc, rules }, result: { rule, rules } }
  })
}

function clearDoc(store, project, now) {
  return changeDoc(store, project, now, (doc) => {
    const items = clearReviewed(doc.items)
    return { doc: { ...doc, items }, result: doc.items.length - items.length }
  }) ?? 0
}

const listData = (doc, project, status) => ({
  project: project.name,
  projectId: project.projectId,
  stats: statsText(doc.items, doc.rules),
  rules: doc.rules,
  items: doc.items.filter(STATUS[status]).reverse(),
})

const clearedText = (n) => `Cleared ${plural(n, 'reviewed assumption')}. Open ones and verdicts not sent yet stay.`

const ERR = (text) => ({ text, isError: true })

const SCOPE = {
  cwd: { type: 'string', description: 'Your working directory.' },
  session_id: { type: 'string', description: 'Your session id, if you know it.' },
}

const tools = [
  {
    name: 'log_assumption',
    description: [
      'Record an assumption you just made while working, so the user can confirm or correct it',
      '(they review with /assumptions or `agent-mods assumptions`). Returns at once; keep working.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        assumption: { type: 'string', maxLength: MAX_TEXT, description: 'The assumption, one short sentence.' },
        context: { type: 'string', maxLength: MAX_TEXT, description: 'Optional: what you are building that depends on it.' },
        ...SCOPE,
      },
      required: ['assumption'],
    },
    run(args, mctx) {
      if (mctx.config?.mods?.[NAME] === false) {
        return { text: 'Assumption tracking is off (agent-mods config mods.assumptions). Keep working.' }
      }
      const text = cleanText(args.assumption)
      if (!text) return ERR('assumption is required')
      const context = cleanText(args.context)
      const { project, caller } = target(args, mctx)
      try {
        touchProjectMeta(mctx.store, project, mctx.now)
      } catch (err) {
        mctx.log(`assumptions meta: ${err?.message ?? err}`)
      }
      const key = caller?.key ?? null
      const agent = caller?.agent ?? mctx.agent ?? null
      return changeDoc(mctx.store, project, mctx.now, (doc) => {
        const id = doc.lastId + 1
        const item = { id, text, ...(context ? { context } : {}), verdict: 'open', isSent: false, agent, sessionKey: key, at: mctx.now }
        // Verdicts waiting for this caller ride along with the result, as with any tool result.
        const taken = takeFeedback([...doc.items, item], key)
        const logged = `Logged as assumption #${id}. Keep working; the user may correct it.`
        return {
          doc: { ...doc, lastId: id, items: taken.items },
          result: {
            text: taken.text ? `${logged}\n\n${taken.text}` : logged,
            data: { id, project: project.name, projectId: project.projectId },
          },
        }
      })
    },
  },
  {
    name: 'assumptions',
    description: [
      'Logged assumptions and the project rules made from corrections. list: stats, rules, items (status).',
      'review: apply a verdict the user stated (id, verdict, correction in their words); never judge items yourself.',
      'feedback: verdicts waiting for you. rules: the rules text. delete_rule (id). clear_reviewed.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'review', 'feedback', 'rules', 'delete_rule', 'clear_reviewed'] },
        id: { type: 'integer', description: 'Assumption id (review) or rule id (delete_rule).' },
        verdict: { type: 'string', enum: ['right', 'wrong'] },
        correction: { type: 'string', maxLength: MAX_TEXT, description: 'For wrong: what the user said it should be.' },
        status: { type: 'string', enum: ['open', 'reviewed', 'all'], description: 'list filter, default open.' },
        ...SCOPE,
      },
      required: ['action'],
    },
    run(args, mctx) {
      const action = args.action ?? 'list'
      const { store, now } = mctx
      const { project, caller } = target(args, mctx)
      const key = caller?.key ?? null
      if (action === 'list') {
        const doc = readDoc(store, project)
        const status = Object.hasOwn(STATUS, args.status ?? '') ? args.status : 'open'
        return { text: renderList(doc, { name: project.name, status, now, forModel: true }), data: listData(doc, project, status) }
      }
      if (action === 'review') {
        const id = parseId(args.id)
        if (!id) return ERR('review needs the assumption id.')
        if (args.verdict !== 'right' && args.verdict !== 'wrong') return ERR('review needs verdict "right" or "wrong".')
        const by = { agent: caller?.agent ?? mctx.agent ?? null, sessionKey: key }
        const correction = cleanText(args.correction)
        const out = judgeItem(store, project, now, { id, verdict: args.verdict, correction, by, takeFor: key })
        if (out.error) return ERR(out.error)
        return { text: verdictReport(store, out), data: { item: out.item, rule: out.change } }
      }
      if (action === 'feedback') {
        const text = changeDoc(store, project, now, (doc) => {
          const taken = takeFeedback(doc.items, key)
          return taken.text ? { doc: { ...doc, items: taken.items }, result: taken.text } : null
        })
        return { text: text ?? 'No new verdicts.' }
      }
      if (action === 'rules') {
        const { rules } = readDoc(store, project)
        return { text: rulesText(rules) ?? `No project rules in ${project.name}.`, data: { project: project.name, rules } }
      }
      if (action === 'delete_rule') {
        const id = parseId(args.id)
        const out = id ? deleteRule(store, project, now, id) : null
        if (!out) return ERR(id ? `No rule #${id} in ${project.name}.` : 'delete_rule needs the rule id.')
        return { text: `Rule #${id} deleted.\n\n${rulesText(out.rules) ?? 'No project rules left.'}`, data: { rules: out.rules } }
      }
      if (action === 'clear_reviewed') return { text: clearedText(clearDoc(store, project, now)) }
      return ERR(`Unknown action: ${action}`)
    },
  },
]

const ASSUMPTIONS_USAGE = `Usage: agent-mods assumptions [list [--all] [--json] | right <id> | wrong <id> [--fix "<correction>"]
                              | y | n [--fix "<correction>"] | clear | status [--json]] [--cwd <dir>]
  list     stats, project rules, then open assumptions newest first (--all: reviewed ones too)
  right    mark an assumption right (drops a rule made from it)
  wrong    mark it wrong; --fix makes the correction a project rule for every agent in this repo
  y | n    the same for the newest open assumption
  clear    remove reviewed assumptions whose verdict was already sent
  status   one-line summary for a status line`

const RULES_USAGE = 'Usage: agent-mods rules [list [--json] | delete <id>] [--cwd <dir>]'

const REVIEW_HINT = 'Mark them: agent-mods assumptions right <id> | wrong <id> --fix "<correction>", or y / n for the newest open one.'

function runAssumptions(c) {
  const [action = 'list', arg] = c.positionals
  const { store, project, now } = c
  if (action === 'list' || action === 'ls') {
    const doc = readDoc(store, project)
    const status = c.flags.all ? 'all' : 'open'
    if (c.json) {
      c.printJson(listData(doc, project, status))
      return 0
    }
    c.print(renderList(doc, { name: project.name, status, now }))
    if (doc.items.some(STATUS.open)) c.print(`\n${REVIEW_HINT}`)
    return 0
  }
  if (['right', 'wrong', 'y', 'n'].includes(action)) {
    const newest = action === 'y' || action === 'n'
    const verdict = action === 'right' || action === 'y' ? 'right' : 'wrong'
    const id = newest ? null : parseId(arg)
    if (!newest && !id) {
      c.error(ASSUMPTIONS_USAGE)
      return 2
    }
    if (c.flags.fix === true) {
      c.error('--fix needs the correction text, for example --fix "use pnpm".')
      return 2
    }
    const correction = verdict === 'wrong' ? cleanText(c.flags.fix) : ''
    const out = judgeItem(store, project, now, { id, newest, verdict, correction, by: 'user' })
    if (out.error) {
      c.error(out.error)
      return 1
    }
    if (c.json) c.printJson({ item: out.item, rule: out.change })
    else c.print(verdictReport(store, out))
    return 0
  }
  if (action === 'clear' || action === 'clear-reviewed') {
    const removed = clearDoc(store, project, now)
    if (c.json) c.printJson({ removed })
    else c.print(clearedText(removed))
    return 0
  }
  if (action === 'status') {
    const doc = readDoc(store, project)
    const label = bandLabel(doc.items, doc.rules.length)
    if (c.json) c.printJson({ label, open: doc.items.filter(STATUS.open).length, total: doc.items.length, rules: doc.rules.length })
    else if (label) c.print(label)
    return 0
  }
  c.error(ASSUMPTIONS_USAGE)
  return 2
}

function runRules(c) {
  const [action = 'list', arg] = c.positionals
  const { store, project, now } = c
  if (action === 'list' || action === 'ls') {
    const { rules } = readDoc(store, project)
    if (c.json) c.printJson(rules)
    else if (!rules.length) c.print(`No project rules in ${project.name}.`)
    else c.print([`Project rules in ${project.name} (from corrections, sent every session):`, ...rules.map(ruleRow)].join('\n'))
    return 0
  }
  if (action === 'delete' || action === 'rm') {
    const id = parseId(arg)
    if (!id) {
      c.error(RULES_USAGE)
      return 2
    }
    const out = deleteRule(store, project, now, id)
    if (!out) {
      c.error(`No rule #${id} in ${project.name}.`)
      return 1
    }
    const left = plural(out.rules.length, 'rule')
    if (c.json) c.printJson({ deleted: out.rule, rules: out.rules })
    else c.print(`Rule #${id} deleted: ${out.rule.correction} (not: "${out.rule.assumption}"). ${left} left.`)
    return 0
  }
  c.error(RULES_USAGE)
  return 2
}

const cli = [
  {
    name: 'assumptions',
    summary: 'Review assumptions agents logged: list, right/wrong <id>, y/n, clear, status',
    usage: ASSUMPTIONS_USAGE,
    run: runAssumptions,
  },
  { name: 'rules', summary: 'Project rules from corrected assumptions: list, delete <id>', usage: RULES_USAGE, run: runRules },
]

// Part of the core briefing tool: what SessionStart injects, for sessions that could not take it.
function briefingPart(m, { project }) {
  return [GUIDANCE, injectedRules(readDoc(m.store, project).rules)]
}

export default { name: NAME, hooks, tools, cli, briefing: briefingPart }
