// Project identity that every agent agrees on.
//
// The same repo reaches us spelled many ways on this host: 'D:\Sample Telegram Projects\X' (Git Bash,
// Grok TUI), 'd:\Sample Telegram Projects\X' (Claude in Devin), 'd:/Sample Telegram Projects/X' (Devin ACP),
// '\\?\D:\...' (Codex state db), '/d/Sample Telegram Projects/X' (MSYS). canonicalPath folds them to one
// display form; keyOf folds case for comparison on Windows. Ideas, rules and design decisions are
// keyed by the git common dir so every worktree of a repo shares them; edit clashes are keyed by the
// worktree, because two worktrees never share files.
import fs from 'node:fs'
import path from 'node:path'
import { sha1, safeName } from './fsx.mjs'

const IS_WIN = process.platform === 'win32'

export function canonicalPath(input, base) {
  if (input === undefined || input === null || String(input).trim() === '') return null
  let value = String(input).trim()
  if (value.startsWith('\\\\?\\UNC\\')) value = `\\\\${value.slice(8)}`
  else if (value.startsWith('\\\\?\\') || value.startsWith('//?/')) value = value.slice(4)
  if (IS_WIN) {
    const msys = /^\/([a-zA-Z])(\/|$)/.exec(value)
    if (msys) value = `${msys[1]}:/${value.slice(3)}`
  }
  value = base ? path.resolve(base, value) : path.resolve(value)
  value = value.replace(/\\/g, '/')
  if (/^[a-zA-Z]:/.test(value)) value = value[0].toLowerCase() + value.slice(1)
  if (value.length > 1 && value.endsWith('/') && !/^[a-z]:\/$/.test(value)) value = value.slice(0, -1)
  return value
}

export function keyOf(canonical) {
  return IS_WIN ? String(canonical).toLowerCase() : String(canonical)
}

export function samePath(a, b) {
  if (!a || !b) return false
  return keyOf(a) === keyOf(b)
}

// Path of `file` relative to `root` with '/' separators, or the canonical absolute path when the
// file is outside root. Used as the clash key inside one worktree.
export function relativeTo(root, file) {
  const abs = canonicalPath(file, root)
  if (!abs) return null
  if (!root) return abs
  const r = keyOf(root)
  const k = keyOf(abs)
  if (k === r) return '.'
  if (k.startsWith(`${r}/`)) return abs.slice(root.length + 1)
  return abs
}

// Walk up from start to the nearest .git (dir = main checkout, file = worktree or submodule).
// Pure fs: spawning git costs ~100 ms per call on this host.
export function findRepo(start) {
  let dir = start
  for (let depth = 0; depth < 64; depth++) {
    const dotGit = path.join(dir, '.git')
    let stat = null
    try {
      stat = fs.statSync(dotGit)
    } catch {}
    if (stat?.isDirectory()) return { worktree: dir, common: dotGit }
    if (stat?.isFile()) {
      let gitdir = null
      try {
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'))
        if (match) gitdir = path.resolve(dir, match[1])
      } catch {}
      if (gitdir) {
        let common = gitdir
        try {
          common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim())
        } catch {}
        return { worktree: dir, common }
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

const cache = new Map()

export function projectInfo(cwdInput) {
  const cwd = canonicalPath(cwdInput || process.cwd())
  if (cache.has(cwd)) return cache.get(cwd)
  const repo = findRepo(cwd)
  const worktreeKey = repo ? canonicalPath(repo.worktree) : cwd
  let repoKey = worktreeKey
  if (repo) {
    const common = canonicalPath(repo.common)
    repoKey = /\/\.git$/i.test(common) ? common.slice(0, -5) : common
  }
  const name = path.posix.basename(repoKey) || repoKey
  const info = {
    cwd,
    worktreeKey,
    repoKey,
    isRepo: Boolean(repo),
    name,
    projectId: `${safeName(name.toLowerCase(), 40)}-${sha1(keyOf(repoKey)).slice(0, 8)}`,
    worktreeId: sha1(keyOf(worktreeKey)).slice(0, 8),
  }
  cache.set(cwd, info)
  return info
}
