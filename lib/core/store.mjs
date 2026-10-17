// The shared store, bound to its root. Every mod reads and writes through this so tests can point
// the whole system at a temp dir (AGENT_MODS_HOME) and so all paths stay under one folder.
import fs from 'node:fs'
import path from 'node:path'
import {
  appendJsonLine,
  listDir,
  readJson,
  readJsonLines,
  removePath,
  safeName,
  updateJson,
  writeJsonAtomic,
} from './fsx.mjs'
import { storeRoot } from './paths.mjs'

export function openStore(root = storeRoot()) {
  const abs = (rel) => (path.isAbsolute(rel) ? rel : path.join(root, rel))
  return {
    root,
    path: (...parts) => path.join(root, ...parts),
    readJson: (rel, fallback = null) => readJson(abs(rel), fallback),
    writeJson: (rel, data) => writeJsonAtomic(abs(rel), data),
    update: (rel, fallback, fn, lockOptions) => updateJson(abs(rel), fallback, fn, lockOptions),
    append: (rel, value) => appendJsonLine(abs(rel), value),
    lines: (rel) => readJsonLines(abs(rel)),
    list: (rel) => listDir(abs(rel)),
    remove: (rel) => removePath(abs(rel)),
    exists: (rel) => fs.existsSync(abs(rel)),
  }
}

export const DEFAULT_CONFIG = {
  mods: {
    sessions: true,
    assumptions: true,
    design: true,
    plain: true,
    ideas: true,
    enhance: true,
    clawd: true,
  },
  notify: { enabled: false, afterMs: 30_000, sound: true },
  debug: { capturePayloads: false },
}

function merge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return structuredClone(base)
  const out = structuredClone(base)
  for (const [key, value] of Object.entries(extra)) {
    out[key] = base[key] && typeof base[key] === 'object' && !Array.isArray(base[key]) ? merge(base[key], value) : value
  }
  return out
}

export function loadConfig(store) {
  return merge(DEFAULT_CONFIG, store.readJson('config.json', {}))
}

export function setConfigValue(store, dottedKey, value) {
  return store.update('config.json', {}, (current) => {
    const next = structuredClone(current ?? {})
    const parts = dottedKey.split('.')
    let node = next
    for (const part of parts.slice(0, -1)) {
      if (!node[part] || typeof node[part] !== 'object') node[part] = {}
      node = node[part]
    }
    node[parts[parts.length - 1]] = value
    return next
  })
}

export function projectFile(project, name) {
  return `projects/${project.projectId}/${name}`
}

// projects/<id>/meta.json keeps the human-readable path and every spelling we have seen.
export function touchProjectMeta(store, project, now = Date.now()) {
  const rel = projectFile(project, 'meta.json')
  const meta = store.readJson(rel, null)
  if (meta && meta.repoKey === project.repoKey && (meta.aliases ?? []).includes(project.cwd)) return
  store.update(rel, null, (current) => {
    const aliases = new Set(current?.aliases ?? [])
    aliases.add(project.cwd)
    return {
      v: 1,
      projectId: project.projectId,
      name: project.name,
      repoKey: project.repoKey,
      isRepo: project.isRepo,
      aliases: [...aliases].slice(-20),
      createdAt: current?.createdAt ?? now,
    }
  })
}

export function sessionKey(agent, id) {
  return `${safeName(agent, 20)}__${safeName(id, 100)}`
}

// Per-session private state of one mod: sessions/<agent>__<id>/<mod>.json
export function sessionState(store, key, mod) {
  const rel = `sessions/${key}/${safeName(mod)}.json`
  return {
    rel,
    read: (fallback = {}) => store.readJson(rel, fallback),
    write: (data) => store.writeJson(rel, data),
    update: (fn, fallback = {}) => store.update(rel, fallback, fn),
  }
}

const MAX_LOG_BYTES = 256 * 1024

export function logError(store, message) {
  try {
    const file = store.path('logs', 'errors.log')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`)
    } catch {}
    fs.appendFileSync(file, `${new Date().toISOString()} ${String(message).slice(0, 4000)}\n`)
  } catch {}
}
