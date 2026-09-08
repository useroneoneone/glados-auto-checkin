import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
process.env.DATABASE_PATH = ':memory:'
process.env.APP_SECRET = 'warning-fixture-only'
process.env.ADMIN_USER = 'warning-fixture'
process.env.ADMIN_PASSWORD = 'warning-fixture-password'
const { db, accountPublic } = await import('../src/db.js')
const { cookieWarningDue, createCookieWarningScanner } = await import('../src/cookie-warnings.js')
const { encrypt } = await import('../src/crypto.js')
let now
let calls
beforeEach(() => {
  db.exec('DELETE FROM accounts')
  now = new Date('2026-09-08T12:00:00Z')
  calls = []
})
after(() => db.close())

function account(id = 1, options = {}) {
  db.prepare(`INSERT INTO accounts (id, label, email, imap_host, imap_user, imap_password_enc,
    cookie_expires_at, webhook_url, webhook_secret_enc, schedule_timezone, last_status, created_at, updated_at)
    VALUES (?, ?, '', '', '', '', ?, ?, ?, 'Asia/Shanghai', 'success', ?, ?)`)
    .run(id, `Fixture ${id}`, '2026-09-10T12:00:00.000Z', `https://fixture${id}.test/hook`,
      encrypt(`fixture-secret-${id}`), now.toISOString(), now.toISOString())
  for (const [key, value] of Object.entries(options)) {
    assert.ok(['enabled', 'cookie_warning_enabled', 'cookie_warning_days', 'cookie_expires_at', 'webhook_url'].includes(key))
    db.prepare(`UPDATE accounts SET ${key} = ? WHERE id = ?`).run(value, id)
  }
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id)
}
function scanner(notify = async (payload) => {
  if (!payload.shouldSend()) return { skipped: true }
  calls.push(payload)
  return { status: 200 }
}) {
  return createCookieWarningScanner({ database: db, clock: () => now, notify, onError: () => {} })
}

test('warning defaults migrate to enabled/3 days and preserve account check-in status', async () => {
  const row = account()
  assert.equal(row.cookie_warning_enabled, 1)
  assert.equal(row.cookie_warning_days, 3)
  const summary = await scanner()()
  assert.equal(summary.sent, 1)
  assert.equal(calls[0].event, 'glados.cookie.expiry')
  assert.equal(calls[0].result.status, 'cookie_expiring')
  assert.equal(calls[0].result.remainingDays, 2)
  assert.equal(calls[0].secret, 'fixture-secret-1')
  const current = db.prepare('SELECT * FROM accounts WHERE id = 1').get()
  assert.equal(current.last_status, 'success')
  assert.equal(accountPublic(current).cookieWarningStatus, 'sent')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checkins').get().n, 0)
})

test('warning window uses exact configured lead days and includes the boundary', () => {
  const row = account(1, { cookie_warning_days: 1 })
  assert.equal(cookieWarningDue(row, now), null)
  now = new Date('2026-09-09T12:00:00Z')
  assert.equal(cookieWarningDue(row, now).remainingDays, 1)
})

test('successful reminders survive scanner recreation and deduplicate within account local day', async () => {
  account()
  const scan = scanner()
  assert.equal((await scan()).sent, 1)
  assert.equal((await scan()).sent, 0)
  assert.equal((await scanner()()).sent, 0)
  now = new Date('2026-09-08T16:01:00Z')
  assert.equal((await scanner()()).sent, 1)
  assert.equal(calls.length, 2)
  assert.notEqual(calls[0].deliveryId, calls[1].deliveryId)
})

test('expiration is notified once per Cookie expiry, not daily forever', async () => {
  account(1, { cookie_expires_at: now.toISOString() })
  const scan = scanner()
  assert.equal((await scan()).sent, 1)
  assert.equal(calls[0].result.status, 'cookie_expired')
  now = new Date('2026-09-10T12:00:00Z')
  assert.equal((await scanner()()).sent, 0)
  assert.equal(calls.length, 1)
})

test('expired warning follows a previous expiring warning', async () => {
  account()
  const scan = scanner()
  await scan()
  now = new Date('2026-09-10T12:00:00Z')
  assert.equal((await scan()).sent, 1)
  assert.equal(calls[1].result.status, 'cookie_expired')
})

test('new expiry gets a new reminder identity', async () => {
  account()
  const scan = scanner()
  await scan()
  db.prepare('UPDATE accounts SET cookie_expires_at = ? WHERE id = 1').run('2026-09-11T12:00:00.000Z')
  assert.equal((await scan()).sent, 1)
  assert.notEqual(calls[0].deliveryId, calls[1].deliveryId)
})

test('disabled accounts, disabled reminders, missing/invalid expiry and missing webhook are ignored', async () => {
  account(1, { enabled: 0 })
  account(2, { cookie_warning_enabled: 0 })
  account(3, { cookie_expires_at: null })
  account(4, { cookie_expires_at: 'not-a-date' })
  account(5, { webhook_url: '' })
  account(6, { cookie_expires_at: '2027-09-10T12:00:00.000Z' })
  assert.equal((await scanner()()).sent, 0)
  assert.equal(calls.length, 0)
})

test('each account uses its own webhook and secret', async () => {
  account(1)
  account(2)
  assert.equal((await scanner()()).sent, 2)
  assert.equal(calls[0].url, 'https://fixture1.test/hook')
  assert.equal(calls[1].url, 'https://fixture2.test/hook')
  assert.notEqual(calls[0].secret, calls[1].secret)
  assert.notEqual(calls[0].deliveryId, calls[1].deliveryId)
})

test('failed delivery retries after one hour using the existing delivery ID and redacts errors', async () => {
  account()
  let attempts = 0
  const scan = scanner(async (payload) => {
    calls.push(payload)
    if (++attempts === 1) throw new Error('failed https://fixture.test/hook?key=fixture-sensitive')
    return { status: 200 }
  })
  assert.equal((await scan()).failed, 1)
  const row = db.prepare('SELECT * FROM accounts WHERE id = 1').get()
  assert.equal(row.last_status, 'success')
  assert.doesNotMatch(accountPublic(row).cookieWarningError, /fixture-sensitive/)
  now = new Date('2026-09-08T12:59:59Z')
  await scan()
  assert.equal(attempts, 1)
  now = new Date('2026-09-08T13:00:00Z')
  assert.equal((await scan()).sent, 1)
  assert.equal(calls[0].deliveryId, calls[1].deliveryId)
  assert.equal(accountPublic(row).cookieWarningError, null)
})

test('overlapping scans coalesce instead of submitting duplicate notifications', async () => {
  account()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const scan = scanner(async (payload) => { calls.push(payload); await gate; return { status: 200 } })
  const first = scan()
  assert.equal(scan(), first)
  assert.equal(calls.length, 1)
  release()
  assert.equal((await first).sent, 1)
})

test('a Cookie refreshed while queued cancels the old reminder', async () => {
  account()
  const scan = scanner(async (payload) => {
    db.prepare('UPDATE accounts SET cookie_expires_at = ? WHERE id = 1').run('2027-01-01T00:00:00.000Z')
    assert.equal(payload.shouldSend(), false)
    return { skipped: true }
  })
  assert.equal((await scan()).skipped, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cookie_warnings').get().n, 0)
})

test('deleting an account cancels a queued reminder and removes its records', async () => {
  account()
  const scan = scanner(async (payload) => {
    db.prepare('DELETE FROM accounts WHERE id = 1').run()
    assert.equal(payload.shouldSend(), false)
    return { skipped: true }
  })
  assert.equal((await scan()).skipped, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cookie_warnings').get().n, 0)
})
