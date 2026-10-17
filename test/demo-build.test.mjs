import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildDemo } from '../demo/build.mjs'
import { tempDir } from './helpers.mjs'

test('demo ships an explicit static dashboard with browser-only transport and no private server code', () => {
  const dir = buildDemo(tempDir('am-demo-build-'))
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
  assert.match(html, /Sample data\. Changes stay in this browser/)
  assert.match(html, /connect-src 'none'/)
  assert.match(html, /src="transport\.js"/)
  assert.ok(!html.includes('src="app.js"'))
  assert.match(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), /new Audio\(new URL\('\.\/done\.wav'/)
  assert.ok(!fs.existsSync(path.join(dir, 'server.mjs')))
  assert.ok(!fs.existsSync(path.join(dir, 'store')))
  for (const file of ['app.js', 'transport.js', 'state.mjs', 'done.wav', 'walkthrough.html']) assert.ok(fs.statSync(path.join(dir, file)).size > 0)
  fs.writeFileSync(path.join(dir, 'credentials.json'), '{}')
  assert.throws(() => buildDemo(dir), /Unexpected demo build entry/)
})
