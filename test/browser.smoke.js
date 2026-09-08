import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { once } from 'node:events'
import express from 'express'
import { chromium } from 'playwright'

process.env.GLADOS_REQUEST_TIMEOUT_MS = '3000'
const app = express()
app.use(express.json())
const accounts = [
  { id: 1, label: 'Fixture Alpha', activeJob: { id: 'a', type: 'checkin', status: 'running' } },
  { id: 2, label: 'Fixture Beta', activeJob: { id: 'b', type: 'checkin', status: 'queued' } },
  { id: 3, label: 'Fixture Gamma', activeJob: { id: 'c', type: 'checkin', status: 'notifying' } },
  { id: 4, label: 'Fixture Manual', activeJob: null },
].map((account) => ({
  ...account, hasCookieSess: true, hasCookieSessSig: true,
  scheduleTime: '07:15', scheduleTimezone: 'Asia/Shanghai', enabled: true,
}))
let manualPolls = 0
let webhookPolls = 0
let savedAccount
app.post('/api/accounts', (req, res) => {
  savedAccount = req.body
  res.status(201).json({ account: { id: 5, ...req.body } })
})
app.get('/api/auth/me', (req, res) => res.json({ user: { username: 'fixture' } }))
app.get('/api/accounts', (req, res) => res.json({ accounts }))
app.get('/api/checkins', (req, res) => res.json({ checkins: [] }))
app.post('/api/accounts/4/checkin', (req, res) => res.status(202).json({ job: { id: 'manual', status: 'queued' } }))
app.post('/api/webhooks/test', (req, res) => res.status(202).json({ job: { id: 'webhook', status: 'queued' } }))
app.get('/api/jobs/:id', (req, res) => {
  if (req.params.id === 'manual') {
    manualPolls += 1
    const status = manualPolls === 1 ? 'running' : manualPolls === 2 ? 'notifying' : 'completed'
    return res.json({ job: { status, type: 'checkin', result: { status: 'success', message: 'Fixture check-in completed' } } })
  }
  webhookPolls += 1
  res.json({ job: { status: webhookPolls < 2 ? 'notifying' : 'completed', result: { status: 200 } } })
})
app.use(express.static('public'))
const server = app.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
process.env.GLADOS_ORIGIN = origin
const { GladosClient } = await import('../src/glados.js')
let fallbackPosts = 0
app.get('/api/user/status', (req, res) => res.json({ data: { email: 'fixture@example.test' } }))
app.get('/api/user/points', (req, res) => res.json({ points: '8.000' }))
app.post('/api/user/checkin', (req, res) => {
  if (++fallbackPosts === 1) return res.status(404).end()
  res.json({ code: 0, message: 'Checkin! Got 8 points' })
})
app.get('/console/checkin', (req, res) => res.send(`<button onclick="fetch('/api/user/checkin',{method:'POST'})">签到</button>`))
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.goto(origin)
  await page.locator('[data-checkin="4"]').waitFor()
  assert.equal(await page.locator('.badge-running').count(), 3)
  assert.equal(await page.locator('[data-checkin="2"]').isDisabled(), true)
  await mkdir('.local-qa', { recursive: true })
  await page.screenshot({ path: '.local-qa/queue-desktop.png', fullPage: true })
  await page.locator('[data-checkin="4"]').click()
  await page.getByText('Fixture check-in completed', { exact: true }).waitFor({ timeout: 15000 })
  assert.equal(await page.locator('[data-checkin="4"]').isEnabled(), true)
  await page.locator('[data-add]').click()
  assert.equal(await page.locator('[name="cookieWarningEnabled"]').isChecked(), true)
  assert.equal(await page.locator('[name="cookieWarningDays"]').inputValue(), '3')
  await page.locator('[name="cookieWarningDays"]').fill('7')
  await page.locator('[name="cookieWarningEnabled"]').uncheck()
  await page.locator('[name="label"]').fill('Expiry fixture')
  await page.locator('[name="sess"]').fill('fixture-session')
  await page.locator('[name="sessSig"]').fill('fixture-sig')
  await page.screenshot({ path: '.local-qa/expiry-settings-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: '.local-qa/expiry-settings-mobile.png', fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.locator('[name="webhookUrl"]').fill('http://fixture.test/hook')
  await page.locator('[data-test-webhook]').click()
  await page.getByText('Webhook 测试成功（HTTP 200）', { exact: true }).waitFor({ timeout: 10000 })
  assert.equal(await page.locator('[data-test-webhook]').isEnabled(), true)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.locator('[name="cookieWarningDays"]').waitFor({ state: 'detached' })
  assert.equal(savedAccount.cookieWarningEnabled, false)
  assert.equal(savedAccount.cookieWarningDays, 7)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForFunction(() => !document.querySelector('.toast'))
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  const table = page.locator('.table-wrap').first()
  await table.evaluate((node) => { node.scrollLeft = node.scrollWidth })
  await page.screenshot({ path: '.local-qa/queue-mobile.png', fullPage: true })
  assert.deepEqual(errors, [])
  const client = new GladosClient({})
  try {
    await client.open()
    const result = await client.checkin()
    assert.equal(result.status, 'success')
    assert.equal(result.points, '8')
    assert.equal(fallbackPosts, 2)
    assert.ok(client.browser)
  } finally { await client.close() }
  console.log('Browser smoke passed: queue stages, manual polling, async webhook test, desktop/mobile screenshots, actual browser fallback.')
} finally {
  await browser.close()
  server.closeAllConnections()
  server.close()
}
