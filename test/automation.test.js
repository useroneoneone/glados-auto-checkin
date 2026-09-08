import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.DATABASE_PATH = ':memory:'
process.env.APP_SECRET = 'fixture-only'
process.env.ADMIN_USER = 'fixture-admin'
process.env.ADMIN_PASSWORD = 'fixture-password'
process.env.CHECKIN_INTERVAL_MS = '0'
process.env.RETRY_DELAY_MS = '0'
process.env.GLADOS_REQUEST_TIMEOUT_MS = '1000'
process.env.WEBHOOK_TIMEOUT_MS = '2000'
process.env.WEBHOOK_ATTEMPTS = '1'

let active = 0
let peak = 0
let checkinCount = 0
let webhookResponses = []
let holdWebhook = false
let failWebhook = false
const server = http.createServer(async (req, res) => {
  if (req.url === '/hook') {
    if (holdWebhook) { webhookResponses.push(res); return }
    res.writeHead(failWebhook ? 400 : 200).end('ok')
    return
  }
  peak = Math.max(peak, ++active)
  await sleep(15)
  active -= 1
  if (req.url.endsWith('/checkin')) checkinCount += 1
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(
    req.url.endsWith('/status') ? { data: { email: 'fixture@example.test' } }
      : req.url.endsWith('/points') ? { points: '8.0000' }
        : { code: 0, message: 'Checkin! Got 8 points' },
  ))
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
process.env.GLADOS_ORIGIN = `http://127.0.0.1:${server.address().port}`
const { db } = await import('../src/db.js')
const { encrypt } = await import('../src/crypto.js')
const { queueCheckin, queueLogin, scheduleDueAccounts, jobs } = await import('../src/automation.js')
const { GladosClient } = await import('../src/glados.js')
after(() => { server.closeAllConnections(); server.close(); db.close() })
beforeEach(() => {
  db.exec('DELETE FROM accounts')
  active = peak = checkinCount = 0
  webhookResponses = []
  holdWebhook = failWebhook = false
})

function addAccount(id, webhook = false) {
  db.prepare(`INSERT INTO accounts
    (id, label, email, imap_host, imap_user, imap_password_enc, cookie_sess_enc, cookie_sess_sig_enc,
      schedule_time, schedule_timezone, webhook_url, created_at, updated_at)
    VALUES (?, ?, '', '', '', '', ?, ?, '12:34', 'UTC', ?, ?, ?)`)
    .run(id, `Fixture ${id}`, encrypt(`fixture-${id}`), encrypt(`sig-${id}`),
      webhook ? `${process.env.GLADOS_ORIGIN}/hook` : null, new Date().toISOString(), new Date().toISOString())
}

test('simultaneous manual/scheduled runs serialize and deduplicate with one history per account', async () => {
  for (let id = 1; id <= 5; id += 1) addAccount(id)
  const login = queueLogin(1)
  const manual = queueCheckin(2)
  const duplicate = queueCheckin('2')
  const scheduled = scheduleDueAccounts(new Date('2026-09-08T12:34:00Z'))
  assert.equal(duplicate.id, manual.id)
  assert.equal(scheduled.find((job) => job.accountId === 2).id, manual.id)
  assert.equal(scheduleDueAccounts(new Date('2026-09-08T12:34:30Z')).length, 0)
  const results = await Promise.all([login, manual, ...scheduled].map((job) => jobs.wait(job.id)))
  assert.ok(results.every((result) => ['success', 'logged_in'].includes(result.status)))
  assert.equal(peak, 1)
  assert.equal(checkinCount, 5)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checkins').get().n, 5)
})

test('slow webhook runs after cleanup and allows the next account to finish', async (t) => {
  addAccount(1, true)
  addAccount(2)
  holdWebhook = true
  const closed = []
  const original = GladosClient.prototype.close
  t.mock.method(GladosClient.prototype, 'close', async function () {
    await original.call(this)
    closed.push(this.account.id)
  })
  const first = queueCheckin(1)
  const second = queueCheckin(2)
  assert.equal((await jobs.wait(second.id)).status, 'success')
  assert.equal(first.status, 'notifying')
  assert.ok(closed.includes(1))
  for (let i = 0; webhookResponses.length === 0 && i < 100; i += 1) await sleep(10)
  assert.equal(webhookResponses.length, 1)
  assert.equal(queueCheckin(1).id, first.id)
  webhookResponses[0].end('ok')
  assert.equal((await jobs.wait(first.id)).status, 'success')
})

test('webhook failure does not turn successful check-in into failure', async () => {
  addAccount(1, true)
  failWebhook = true
  const result = await jobs.wait(queueCheckin(1).id)
  assert.equal(result.status, 'success')
  assert.match(result.webhookError, /400/)
  const row = db.prepare('SELECT * FROM checkins').get()
  assert.equal(row.status, 'success')
  assert.match(row.message, /Webhook 推送失败/)
})

test('missing/deleted queued account does not block unrelated accounts or retain a lock', async () => {
  addAccount(1)
  addAccount(2)
  const first = queueCheckin(1)
  const deleted = queueCheckin(2)
  db.prepare('DELETE FROM accounts WHERE id = 2').run()
  await assert.rejects(jobs.wait(deleted.id), /账号不存在/)
  assert.equal((await jobs.wait(first.id)).status, 'success')
  addAccount(2)
  assert.equal((await jobs.wait(queueCheckin(2).id)).status, 'success')
})

test('initialization failures release queue and close partially created clients', async (t) => {
  addAccount(1)
  addAccount(2)
  const original = GladosClient.prototype.open
  t.mock.method(GladosClient.prototype, 'open', async function () {
    if (this.account.id === 1) throw new Error('fixture initialization timeout')
    return original.call(this)
  })
  const results = await Promise.all([queueCheckin(1), queueCheckin(2)].map((job) => jobs.wait(job.id)))
  assert.equal(results[0].status, 'failed')
  assert.equal(results[1].status, 'success')
})

test('old failed webhook cannot replace a newer login status', async () => {
  addAccount(1, true)
  holdWebhook = true
  const checkin = queueCheckin(1)
  const login = queueLogin(1)
  await jobs.wait(login.id)
  for (let i = 0; webhookResponses.length === 0 && i < 150; i += 1) await sleep(10)
  assert.equal(webhookResponses.length, 1)
  webhookResponses[0].writeHead(400).end()
  await jobs.wait(checkin.id)
  const row = db.prepare('SELECT last_status, last_message FROM accounts WHERE id = 1').get()
  assert.equal(row.last_status, 'logged_in')
  assert.equal(row.last_message, 'Cookie 登录态有效')
})
