// The hook runtime: parse -> detect agent -> normalize -> run each mod -> render that agent's reply.
// Every failure is swallowed (logged to <store>/logs/errors.log): a hook must never block or break
// an agent session.
import { canInjectContext, detectAgent, fitContext, normalizeEvent, renderOutput } from './agents.mjs'
import { projectInfo } from './project.mjs'
import { storeRoot } from './paths.mjs'
import { loadConfig, logError, openStore, sessionKey, sessionState, touchProjectMeta } from './store.mjs'
import { capturePayload } from './capture.mjs'

export async function runHook({ argv = [], env = process.env, stdinText = '', now = Date.now(), mods } = {}) {
  if (env.AGENT_MODS_DISABLE === '1') return ''
  let payload
  try {
    payload = JSON.parse(String(stdinText).replace(/^﻿/, '').trim())
  } catch {
    return ''
  }
  if (!payload || typeof payload !== 'object') return ''
  const agent = detectAgent({ argv, env, payload })
  const ev = normalizeEvent(agent, payload, env)
  if (!ev.event || !ev.sessionId) return ''
  // Grok runs Stop once more, observe-only, when the session closes; only end_turn is a real stop.
  if (agent === 'grok' && ev.event === 'Stop' && ev.reason && ev.reason !== 'end_turn') return ''

  const store = openStore(storeRoot(env))
  const config = loadConfig(store)
  if (config.debug?.capturePayloads) capturePayload(store, ev, env)

  const project = projectInfo(ev.cwd)
  try {
    touchProjectMeta(store, project, now)
  } catch (err) {
    logError(store, `meta: ${err?.stack ?? err}`)
  }

  const key = sessionKey(agent, ev.sessionId)
  const out = { context: [], notice: [], block: null }
  const ctx = {
    ev,
    now,
    env,
    config,
    project,
    store,
    session: { key, agent, id: ev.sessionId, state: (mod) => sessionState(store, key, mod) },
    record: null,
    out,
    log: (message) => logError(store, message),
  }

  const list = mods ?? (await import('../mods/index.mjs')).MODS
  for (const mod of list) {
    if (config.mods?.[mod.name] === false) continue
    const handler = mod.hooks?.[ev.event]
    if (!handler) continue
    try {
      await handler(ctx)
    } catch (err) {
      logError(store, `${mod.name}.${ev.event} (${agent}): ${err?.stack ?? err}`)
    }
  }

  return deliver(ctx)
}

// Context an agent cannot take on this event (Grok at SessionStart, Devin at PreToolUse...) waits in
// sessions/<key>/pending.json and goes out with the next event that can carry it.
function deliver(ctx) {
  const { ev, store, session, out } = ctx
  let parts = out.context.filter(Boolean)
  const pending = session.state('pending')
  try {
    if (canInjectContext(ev.agent, ev.event)) {
      let items = []
      pending.update((current) => {
        items = Array.isArray(current?.items) ? current.items : []
        return items.length ? { items: [] } : undefined
      }, { items: [] })
      if (items.length) parts = [...items, ...parts]
    } else if (parts.length && ev.event !== 'SessionEnd' && !out.block) {
      const text = fitContext(parts)
      pending.update((current) => ({ items: [...(current?.items ?? []), text].slice(-8) }), { items: [] })
      parts = []
    }
  } catch (err) {
    logError(store, `pending (${ev.agent}): ${err?.stack ?? err}`)
  }
  return renderOutput(ev.agent, ev.event, {
    context: fitContext(parts),
    notice: out.notice.filter(Boolean).join('\n'),
    block: out.block,
  })
}
