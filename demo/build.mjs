import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const DASHBOARD = path.join(ROOT, 'lib/dashboard/public')
const MEDIA = ['dashboard-overview.png', 'dashboard-mobile.png', 'dashboard-assumptions.png', 'dashboard-demo.webm', 'dashboard-demo.gif']

export function buildDemo(output = path.join(ROOT, '.demo-site')) {
  const target = path.resolve(output)
  if (target === ROOT) throw new Error('The demo output must be a separate directory.')
  fs.mkdirSync(target, { recursive: true })
  const copy = (from, to) => {
    fs.mkdirSync(path.dirname(path.join(target, to)), { recursive: true })
    fs.copyFileSync(path.join(ROOT, from), path.join(target, to))
  }
  for (const file of ['app.css', 'app.js', 'pets.js', 'favicon.svg']) copy(`lib/dashboard/public/${file}`, file)
  const appFile = path.join(target, 'app.js')
  fs.writeFileSync(appFile, fs.readFileSync(appFile, 'utf8').replace("new Audio('/done.wav')", "new Audio(new URL('./done.wav', import.meta.url))"))
  for (const file of ['clawd-world.mjs', 'clawd-sprite.mjs']) copy(`lib/mods/${file}`, file)
  copy('assets/done.wav', 'done.wav')
  for (const file of ['transport.js', 'state.mjs', 'demo.css', 'walkthrough.html']) copy(`demo/${file}`, file)
  for (const file of MEDIA) if (fs.existsSync(path.join(ROOT, 'docs/media', file))) copy(`docs/media/${file}`, `media/${file}`)
  const banner = '<aside class="demo-banner" aria-label="Demo information"><p><strong>Interactive demo</strong>Sample data. Changes stay in this browser.</p><nav class="demo-links" aria-label="Demo links"><a href="walkthrough.html">Watch walkthrough</a><a href="https://github.com/naimkatiman/agent-mods">Source and setup</a><button type="button" id="demo-reset">Reset demo</button></nav></aside>'
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; connect-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; media-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'">`
  const html = fs.readFileSync(path.join(DASHBOARD, 'index.html'), 'utf8')
    .replace('<title>agent-mods</title>', '<title>agent-mods | Interactive demo</title>')
    .replace('<head>', `<head>\n${csp}`)
    .replace('src="app.js"', 'src="transport.js"')
    .replace('</head>', '<link rel="stylesheet" href="demo.css">\n</head>')
    .replace('<body data-conn="connecting">', `<body data-conn="connecting">\n${banner}`)
  fs.writeFileSync(path.join(target, 'index.html'), html)
  fs.writeFileSync(path.join(target, '.nojekyll'), '')
  fs.writeFileSync(path.join(target, 'build-info.json'), JSON.stringify({ commit: process.env.GITHUB_SHA || null, mode: 'synthetic-browser-demo' }) + '\n')
  const expected = new Set(['index.html', '.nojekyll', 'build-info.json', 'app.css', 'app.js', 'pets.js', 'favicon.svg', 'clawd-world.mjs', 'clawd-sprite.mjs', 'done.wav', 'transport.js', 'state.mjs', 'demo.css', 'walkthrough.html', 'media'])
  for (const name of fs.readdirSync(target)) if (!expected.has(name)) throw new Error(`Unexpected demo build entry: ${name}`)
  if (fs.existsSync(path.join(target, 'media'))) for (const name of fs.readdirSync(path.join(target, 'media'))) if (!MEDIA.includes(name)) throw new Error(`Unexpected demo media: ${name}`)
  return target
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(buildDemo(process.argv[2]))
