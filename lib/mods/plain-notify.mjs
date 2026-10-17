// Finish alerts: assets/notify.ps1 (toast + WAV), started so that the hook never waits for it.
//
// Two stages, because neither one-step spawn works on Windows (probed on this host, 2026-10-11):
// Windows PowerShell 5.1 started detached (DETACHED_PROCESS, so no console) exits 0 without running
// anything, with -File, -Command and -EncodedCommand alike; and a child that is not detached is
// killed when the hook exits (libuv puts it in a kill-on-close job). So the hook starts THIS file
// detached under node (launchNotifier) and returns; run as a script, this file starts PowerShell
// attached and hidden, which gives it a console of its own, and waits for it (runNotifier).
// Spawners are injectable so tests check both commands without starting anything.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CODE_ROOT } from '../core/paths.mjs'

export const NOTIFY_SCRIPT = path.join(CODE_ROOT, 'assets', 'notify.ps1')
export const DONE_WAV = path.join(CODE_ROOT, 'assets', 'done.wav')
export const NOTIFY_RUNNER = fileURLToPath(import.meta.url)
// The toast plus a 1.65 s sound take about 3 s; anything past this is a hung PowerShell.
const RUNNER_TIMEOUT_MS = 30_000

// powershell.exe -File binds a value shaped like "-name:..." (or a lone "-") as a parameter name,
// fails, and the script never runs (probed on this host). A project folder called "-tmp" makes the
// message "-tmp: ...", so such values get a leading space.
function fileArg(value) {
  const text = String(value ?? '')
  return text.startsWith('-') ? ` ${text}` : text
}

export function notifierArgs({ title, message, sound }) {
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', NOTIFY_SCRIPT, '-Title', fileArg(title), '-Message', fileArg(message),
  ]
  if (sound) args.push('-Sound', fileArg(sound))
  return args
}

// Hook side: start the runner detached and return at once. True when it was started. Windows only:
// elsewhere there is nothing to run.
export function launchNotifier(alert, { spawner = spawn, platform = process.platform, node = process.execPath } = {}) {
  if (platform !== 'win32') return false
  try {
    const args = [NOTIFY_RUNNER, String(alert.title ?? ''), String(alert.message ?? ''), alert.sound ? String(alert.sound) : '']
    const child = spawner(node, args, { detached: true, stdio: 'ignore', windowsHide: true })
    // A spawn failure arrives as an 'error' event; unheard, it would crash the process.
    child?.on?.('error', () => {})
    child?.unref?.()
    return true
  } catch {
    return false
  }
}

// Runner side: PowerShell attached and hidden, waited for, killed if it hangs. Resolves true when it
// exited on its own.
export function runNotifier([title = '', message = '', sound = ''] = [], { spawner = spawn, timeoutMs = RUNNER_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawner('powershell.exe', notifierArgs({ title, message, sound }), { stdio: 'ignore', windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      resolve(false)
    }, timeoutMs)
    timer.unref?.()
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

function isEntryPoint() {
  const entry = process.argv[1]
  if (!entry) return false
  const fold = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
  return fold(entry) === fold(NOTIFY_RUNNER)
}

if (isEntryPoint()) runNotifier(process.argv.slice(2)).then(() => process.exit(0))
