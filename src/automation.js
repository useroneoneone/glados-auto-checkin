import cron from 'node-cron'
import { db } from './db.js'
import { config } from './config.js'
import { decrypt } from './crypto.js'
import { GladosClient } from './glados.js'
import { JobRegistry } from './jobs.js'
import { deliverWebhook } from './webhook.js'
import { safeErrorMessage } from './errors.js'
import { createCookieWarningScanner } from './cookie-warnings.js'

export const checkCookieWarnings = createCookieWarningScanner({ database: db })

export const jobs = new JobRegistry({
  intervalMs: config.checkinIntervalMs,
  onError: (job) => console.error(`Task ${job.id} (${job.type}, account ${job.accountId}) failed: ${job.error}`),
})

function getAccount(accountId) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId)
  if (!account) throw new Error('账号不存在')
  return account
}

async function executeCheckin(accountId) {
  // Read after dequeuing so edits/deletes made while waiting take effect.
  const account = getAccount(accountId)
  let result
  let client
  try {
    const expiresAt = Date.parse(account.cookie_expires_at || '')
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      result = { status: 'login_required', message: 'Cookie 已过期，请在后台更新' }
    } else {
      client = new GladosClient(account)
      await client.open()
      result = await client.checkin()
    }
  } catch (error) {
    result = { status: 'failed', message: safeErrorMessage(error) }
  } finally {
    // Cleanup is always awaited before releasing the GLaDOS queue.
    try { await client?.close() } catch (error) { console.error(`Client cleanup failed: ${safeErrorMessage(error)}`) }
  }
  const now = new Date().toISOString()
  result.checkedAt = now
  const checkinId = db.transaction(() => {
    if (!db.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId)) return null
    db.prepare('UPDATE accounts SET last_status = ?, last_message = ?, last_checked_at = ?, updated_at = ? WHERE id = ?')
      .run(result.status, result.message || '', now, now, accountId)
    return db.prepare('INSERT INTO checkins (account_id, status, message, points, points_change, left_days, raw_json, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(accountId, result.status, result.message || '', result.points ?? null, result.pointsChange ?? null, result.leftDays ?? null, JSON.stringify(result.raw || {}), now).lastInsertRowid
  })()
  return { account, checkinId, result }
}

async function notifyCheckin({ account, checkinId, result }, job) {
  if (!checkinId || !account.webhook_url) return result
  try {
    result.webhook = await deliverWebhook({
      url: account.webhook_url,
      secret: account.webhook_secret_enc ? decrypt(account.webhook_secret_enc) : '',
      account: { id: account.id, label: account.label, email: account.email, cookieExpiresAt: account.cookie_expires_at },
      result,
      deliveryId: job.id,
    })
  } catch (error) {
    result.webhookError = safeErrorMessage(error)
    const message = `${result.message || result.status}；Webhook 推送失败：${result.webhookError}`.slice(0, 500)
    // A slow earlier delivery must not overwrite a newer check-in/login status.
    db.prepare('UPDATE accounts SET last_message = ? WHERE id = ? AND last_checked_at = ? AND last_status = ?')
      .run(message, account.id, result.checkedAt, result.status)
    db.prepare('UPDATE checkins SET message = ? WHERE id = ?').run(message, checkinId)
    console.error(`Webhook failed for account ${account.id}: ${result.webhookError}`)
  }
  return result
}

async function executeLogin(accountId) {
  const account = getAccount(accountId)
  const client = new GladosClient(account)
  try {
    const expiresAt = Date.parse(account.cookie_expires_at || '')
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) throw new Error('Cookie 已过期，请在后台更新')
    await client.open()
    const current = await client.status()
    if (!current.loggedIn) throw new Error('Cookie 未登录或已失效')
    const now = new Date().toISOString()
    db.prepare('UPDATE accounts SET last_status = ?, last_message = ?, last_checked_at = ?, updated_at = ? WHERE id = ?')
      .run('logged_in', 'Cookie 登录态有效', now, now, accountId)
    return { status: 'logged_in', message: 'Cookie 登录态有效' }
  } catch (error) {
    const message = safeErrorMessage(error)
    const now = new Date().toISOString()
    db.prepare('UPDATE accounts SET last_status = ?, last_message = ?, last_checked_at = ?, updated_at = ? WHERE id = ?')
      .run('login_failed', message, now, now, accountId)
    throw new Error(message)
  } finally {
    try { await client.close() } catch (error) { console.error(`Client cleanup failed: ${safeErrorMessage(error)}`) }
  }
}

export function queueCheckin(accountId, source = 'manual') {
  return jobs.enqueue({ type: 'checkin', accountId: Number(accountId), source },
    () => executeCheckin(Number(accountId)), notifyCheckin)
}

export function queueLogin(accountId) {
  return jobs.enqueue({ type: 'login', accountId: Number(accountId) }, () => executeLogin(Number(accountId)))
}

export function runAccount(accountId) { return jobs.wait(queueCheckin(accountId).id) }
export function loginAccount(accountId) { return jobs.wait(queueLogin(accountId).id) }

export function testWebhook({ url, secret = '', label = 'Webhook 测试' }) {
  return deliverWebhook({
    url, secret, event: 'glados.webhook.test', account: { id: null, label },
    result: { status: 'test', message: 'Webhook 测试消息' },
  })
}

export function queueWebhookTest(input) {
  return jobs.enqueue({ type: 'webhook_test' }, () => input, testWebhook)
}

function scheduleParts(timezone, now) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` }
}

export function scheduleDueAccounts(now = new Date()) {
  const scheduled = []
  for (const account of db.prepare('SELECT * FROM accounts WHERE enabled = 1').all()) {
    let current
    try { current = scheduleParts(account.schedule_timezone || 'Asia/Shanghai', now) } catch { continue }
    if (current.time !== (account.schedule_time || '07:15')) continue
    const claimed = db.prepare(`UPDATE accounts SET last_scheduled_date = ?
      WHERE id = ? AND (last_scheduled_date IS NULL OR last_scheduled_date <> ?)`).run(current.date, account.id, current.date)
    if (claimed.changes) scheduled.push(queueCheckin(account.id, 'scheduled'))
  }
  return scheduled
}

export function startScheduler() {
  const scanWarnings = () => checkCookieWarnings().catch((error) => console.error(`Cookie warning scan failed: ${safeErrorMessage(error)}`))
  scanWarnings()
  return cron.schedule('* * * * *', () => {
    try { scheduleDueAccounts() } catch (error) { console.error(`Scheduler failed: ${safeErrorMessage(error)}`) }
    scanWarnings()
  })
}
