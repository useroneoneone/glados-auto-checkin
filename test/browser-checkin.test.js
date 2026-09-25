import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { chromium } from 'playwright'

let posts = 0
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glados-browser-test-'))
const server = http.createServer((req, res) => {
  if (req.url === '/console/checkin') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(`<!doctype html><button id="checkin">签到</button><script>document.querySelector('#checkin').onclick=async()=>{const r=await fetch('/api/user/checkin',{method:'POST'});document.body.dataset.result=await r.text()}</script>`)
    return
  }
  if (req.url === '/api/user/checkin' && req.method === 'POST') {
    posts += 1
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ code: 0, points: 7, message: 'Checkin! Got 7 Points' }))
    return
  }
  res.writeHead(404).end()
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
process.env.GLADOS_ORIGIN = `http://127.0.0.1:${server.address().port}`
process.env.BROWSER_PROFILES_PATH = profileRoot
const { BrowserCheckinManager } = await import('../src/browser-checkin.js')
after(async () => { server.closeAllConnections(); server.close() })

const executablePath = process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : undefined

function launch(userDataDir, options) {
  return chromium.launchPersistentContext(userDataDir, {
    ...options,
    ...(executablePath ? { executablePath } : {}),
  })
}

test('browser mode persists a profile and submits through the page click handler', async () => {
  const manager = new BrowserCheckinManager({
    headless: true,
    launch,
  })
  const account = { id: 77, schedule_timezone: 'UTC' }
  const result = await manager.checkin(account)
  assert.equal(result.status, 'success', result.message)
  assert.equal(result.pointsChange, '7')
  assert.equal(posts, 1)
  assert.equal(manager.sessions.size, 0)
  await manager.closeAll()
})

test('browser login session stays open for the user and is reused by scheduled click', async () => {
  const manager = new BrowserCheckinManager({
    headless: true,
    launch,
  })
  const account = { id: 78, schedule_timezone: 'UTC' }
  const opened = await manager.beginLogin(account)
  assert.equal(opened.reused, false)
  assert.equal(manager.sessions.size, 1)
  const result = await manager.checkin(account)
  assert.equal(result.status, 'success', result.message)
  assert.equal(manager.sessions.size, 1)
  await manager.closeAll()
})
