import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'glados-exchange-')), 'fixture.sqlite')
process.env.APP_SECRET = 'fixture-only'
process.env.ADMIN_USER = 'fixture-admin'
process.env.ADMIN_PASSWORD = 'fixture-password'
process.env.CHECKIN_INTERVAL_MS = '0'
process.env.RETRY_DELAY_MS = '0'
process.env.GLADOS_REQUEST_TIMEOUT_MS = '180'
process.env.GLADOS_REQUEST_ATTEMPTS = '1'

const fixtures = new Map()
const notifications = []
const plans = { plan100: { points: 100, days: 10 }, plan200: { points: 200, days: 30 }, plan500: { points: 500, days: 100 } }
const server = http.createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  if (req.url === '/hook') { notifications.push(JSON.parse(body)); res.end('ok'); return }
  const id = Number(/gld:sess=account-(\d+)/.exec(req.headers.cookie || '')?.[1])
  const fixture = fixtures.get(id)
  if (!fixture) { res.writeHead(401).end(); return }
  const route = req.url.split('/').at(-1)
  fixture.counts[route] = (fixture.counts[route] || 0) + 1
  res.setHeader('content-type', 'application/json')
  if (fixture.counts.exchange && (fixture.refreshDown && ['status', 'points'].includes(route) || fixture.statusDown && route === 'status' || fixture.pointsDown && route === 'points')) { res.writeHead(503).end(); return }
  if (fixture.changeFlags && route === 'points') db.prepare('UPDATE accounts SET auto_exchange_enabled = 0 WHERE id = ?').run(id)
  if (route === 'status') res.end(JSON.stringify({ code: 0, data: { email: `account-${id}@example.test`, leftDays: String(fixture.leftDays), vip: fixture.vip } }))
  else if (route === 'points') res.end(JSON.stringify({ code: 0, points: String(fixture.points), history: fixture.history, plans: fixture.plans }))
  else if (route === 'checkin') {
    if (!fixture.failed && !fixture.already) fixture.points += 8
    res.end(JSON.stringify(fixture.failed ? { code: 1, message: 'Checkin failed' }
      : fixture.already ? { code: 1, message: 'Already checked in' }
        : { code: 0, points: 8, message: 'Checkin! Got 8 points', list: [{ balance: String(fixture.points), change: '8' }] }))
  } else if (route === 'exchange') {
    const { planType } = JSON.parse(body)
    fixture.submitted.push(planType)
    if (fixture.reject) { res.end(JSON.stringify({ code: 1, message: 'plan unavailable' })); return }
    if (!fixture.notApplied) {
      const plan = fixture.plans[planType]
      fixture.points -= plan.points
      fixture.leftDays += plan.days
      fixture.vip = fixture.afterVip ?? fixture.vip
      fixture.history.unshift({ id: ++fixture.ledgerId, time: Date.now(), business: `system:ex:${planType}:2026-10-03`, change: String(-plan.points), balance: String(fixture.points) })
    }
    // An actual POST deadline, including the case where the server already applied it.
    if (fixture.timeout) return
    res.end(JSON.stringify({ code: 0, message: 'Successfully exchanged', points: String(fixture.points), history: fixture.history }))
  } else res.writeHead(404).end()
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
process.env.GLADOS_ORIGIN = `http://127.0.0.1:${server.address().port}`
const { db, accountPublic } = await import('../src/db.js')
const { encrypt } = await import('../src/crypto.js')
const { runAccount, loginAccount } = await import('../src/automation.js')
const { GladosClient } = await import('../src/glados.js')
const { autoExchange } = await import('../src/exchange.js')
after(() => { server.closeAllConnections(); server.close(); db.close() })
beforeEach(() => { db.exec('DELETE FROM accounts'); fixtures.clear(); notifications.length = 0 })

function add(id = 1, options = {}) {
  const fixture = { leftDays: 1.2, vip: 31, points: 550, history: [], ledgerId: 10, plans, counts: {}, submitted: [], ...options }
  fixtures.set(id, fixture)
  db.prepare(`INSERT INTO accounts (id, label, email, imap_host, imap_user, imap_password_enc,
    cookie_enc, cookie_format_version, auto_exchange_enabled, enabled, webhook_url, created_at, updated_at)
    VALUES (?, ?, '', '', '', '', ?, 5, ?, ?, ?, ?, ?)`)
    .run(id, `Account ${id}`, encrypt(`gld:sess=account-${id}; gld:sess.sig=fixture-signature`),
      options.auto === false ? 0 : 1, options.enabled === false ? 0 : 1,
      options.webhook ? `${process.env.GLADOS_ORIGIN}/hook` : null, new Date().toISOString(), new Date().toISOString())
  return fixture
}
const publicAccount = (id = 1) => accountPublic(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id))

test('longest affordable tier is exchanged once, then days, plan, points and Webhook update', async () => {
  const fixture = add(1, { afterVip: 41, webhook: true })
  const result = await runAccount(1)
  assert.deepEqual(fixture.submitted, ['plan500'])
  assert.equal(result.exchange.status, 'success')
  assert.equal(result.exchange.days, 100)
  assert.equal(result.pointsChange, '8')
  assert.equal(publicAccount().currentPoints, '58')
  assert.equal(publicAccount().daysLeft, 101)
  assert.equal(publicAccount().plan, 'Team')
  assert.equal(notifications[0].result.exchange.status, 'success')
  assert.equal(notifications[0].result.points, '58')
  assert.equal(notifications[0].result.plan, 'Team')
  assert.equal(notifications[0].result.leftDays, '101.2')
  fixture.already = true
  await runAccount(1)
  assert.equal(fixture.counts.exchange, 1)
})

test('selection respects affordability and disabled tiers rather than price or catalog order', async () => {
  const fixture = add(1, { points: 250, plans: { plan500: plans.plan500, unavailable: { points: 1, days: 500, available: false }, plan100: plans.plan100, plan200: plans.plan200, disabled: { points: 1, days: 900, enabled: false } } })
  await runAccount(1)
  assert.deepEqual(fixture.submitted, ['plan200'])
  assert.equal(publicAccount().currentPoints, '58')
})

test('official displayed 1 uses rounding: 0.5 and 1.49 trigger; 0.49 and 1.5 do not', async () => {
  for (const [id, days, expected] of [[1, 0.5, 1], [2, 1.49, 1], [3, 0.49, 0], [4, 1.5, 0]]) {
    const fixture = add(id, { leftDays: days })
    await runAccount(id)
    assert.equal(fixture.counts.exchange || 0, expected)
  }
})

test('per-account defaults, pausing, failed check-in and login detection never redeem', async () => {
  for (const [id, options] of [[1, { auto: false }], [2, { enabled: false }], [3, { failed: true }], [4, {}]]) {
    const fixture = add(id, options)
    if (id === 4) await loginAccount(id)
    else await runAccount(id)
    assert.equal(fixture.counts.exchange, undefined)
  }
  assert.equal(publicAccount(4).plan, 'Pro')
  assert.equal(publicAccount(4).daysLeft, 1)
})

test('already signed still checks once; insufficient points never post', async () => {
  const first = add(1, { already: true, points: 220 })
  assert.equal((await runAccount(1)).status, 'already_signed')
  assert.deepEqual(first.submitted, ['plan200'])
  const second = add(2, { points: 10 })
  assert.equal((await runAccount(2)).exchange.status, 'skipped')
  assert.equal(second.counts.exchange, undefined)
})

test('turning the switch off during fresh reads prevents POST', async () => {
  const fixture = add(1, { changeFlags: true })
  await runAccount(1)
  assert.equal(fixture.counts.exchange, undefined)
})

test('timed out POST already applied is verified from a new exchange ledger, never replayed', async () => {
  const fixture = add(1, { timeout: true })
  const result = await runAccount(1)
  assert.equal(result.exchange.status, 'success')
  assert.equal(result.exchange.verified, true)
  assert.equal(publicAccount().currentPoints, '58')
  await runAccount(1)
  assert.equal(fixture.counts.exchange, 1)
})

test('uncertain timeout remains guarded on disk and a fresh client only verifies after restart', async () => {
  const fixture = add(1, { timeout: true, notApplied: true,
    history: [{ id: 5, time: Date.now(), business: 'system:ex:plan500:2026-10-03', change: '-500' }] })
  assert.equal((await runAccount(1)).exchange.status, 'unknown')
  const reopened = new Database(process.env.DATABASE_PATH)
  const client = new GladosClient(reopened.prepare('SELECT * FROM accounts WHERE id = 1').get())
  await client.open()
  try {
    const result = { status: 'already_signed', message: 'Already signed' }
    await autoExchange({ database: reopened, accountId: 1, client, result })
    assert.equal(result.exchange.status, 'unknown')
    assert.equal(fixture.counts.exchange, 1)
    // An unrelated newer deduction must not count as a redemption.
    fixture.history.unshift({ id: 11, time: Date.now(), business: 'system:casino', change: '-500' })
    await autoExchange({ database: reopened, accountId: 1, client, result })
    assert.equal(result.exchange.status, 'unknown')
    fixture.history.unshift({ id: 12, time: Date.now(), business: 'system:ex:plan500:2026-10-03', change: '-500' })
    fixture.leftDays = 101.2
    fixture.points = 58
    await autoExchange({ database: reopened, accountId: 1, client, result })
    assert.equal(result.exchange.status, 'success')
    assert.equal(result.points, '58')
    assert.equal(fixture.counts.exchange, 1)
  } finally { await client.close(); reopened.close() }
})

test('durable pending intent from interrupted process is verified without POST', async () => {
  const fixture = add()
  db.prepare(`INSERT INTO exchanges (account_id, plan_type, days, cost, status, before_json, created_at, updated_at)
    VALUES (1, 'plan500', 100, 500, 'pending', ?, ?, ?)`)
    .run(JSON.stringify({ historyKnown: true, historyIds: [] }), new Date().toISOString(), new Date().toISOString())
  assert.equal((await runAccount(1)).exchange.status, 'unknown')
  assert.equal(fixture.counts.exchange, undefined)
})

test('success with failed refresh and stale days cannot trigger a second exchange', async () => {
  const fixture = add(1, { refreshDown: true })
  const result = await runAccount(1)
  assert.equal(result.status, 'success')
  assert.equal(result.exchange.status, 'success')
  assert.equal(result.exchange.refreshed, false)
  fixture.refreshDown = false
  fixture.leftDays = 1.2
  assert.equal((await runAccount(1)).exchange.status, 'skipped')
  assert.equal(fixture.counts.exchange, 1)
})

test('explicit rejection preserves check-in success and submits only once', async () => {
  const fixture = add(1, { reject: true })
  const result = await runAccount(1)
  assert.equal(result.status, 'success')
  assert.equal(result.exchange.status, 'failed')
  assert.equal(fixture.counts.exchange, 1)
  assert.equal(db.prepare('SELECT guard_active FROM exchanges').get().guard_active, 0)
})

test('partial refresh preserves successful redemption and updates the remaining available attributes', async () => {
  add(1, { pointsDown: true, afterVip: 41 })
  const first = await runAccount(1)
  assert.equal(first.exchange.status, 'success')
  assert.equal(first.exchange.refreshed, false)
  assert.equal(publicAccount(1).daysLeft, 101)
  assert.equal(publicAccount(1).plan, 'Team')
  assert.equal(publicAccount(1).currentPoints, '58')
  add(2, { statusDown: true, timeout: true })
  const second = await runAccount(2)
  assert.equal(second.exchange.status, 'success')
  assert.equal(second.exchange.verified, true)
  assert.equal(publicAccount(2).currentPoints, '58')
  assert.equal(second.exchange.refreshed, false)
  assert.match(second.message, /刷新失败/)
})

test('another account remains independent while a prior outcome is unknown', async () => {
  const first = add(1, { timeout: true, notApplied: true })
  const second = add(2)
  assert.equal((await runAccount(1)).exchange.status, 'unknown')
  assert.equal((await runAccount(2)).exchange.status, 'success')
  await runAccount(1)
  assert.equal(first.counts.exchange, 1)
  assert.deepEqual(second.submitted, ['plan500'])
})
