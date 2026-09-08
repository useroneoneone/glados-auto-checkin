import { randomUUID } from 'node:crypto'
import { decrypt } from './crypto.js'
import { deliverWebhook } from './webhook.js'
import { safeErrorMessage } from './errors.js'

const DAY_MS = 24 * 60 * 60 * 1000
const RETRY_INTERVAL_MS = 60 * 60 * 1000

export function cookieWarningDue(account, now) {
  if (!account?.enabled || !account.cookie_warning_enabled || !account.webhook_url) return null
  const expiry = Date.parse(account.cookie_expires_at || '')
  if (!Number.isFinite(expiry)) return null
  const remaining = expiry - now.getTime()
  if (remaining > account.cookie_warning_days * DAY_MS) return null
  const timezone = account.schedule_timezone || 'Asia/Shanghai'
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map((part) => [part.type, part.value]))
  const phase = remaining <= 0 ? 'expired' : 'expiring'
  return {
    phase,
    periodKey: phase === 'expired' ? 'once' : `${parts.year}-${parts.month}-${parts.day}`,
    remainingDays: Math.max(0, Math.ceil(remaining / DAY_MS)),
    expiryLabel: new Date(expiry).toLocaleString('zh-CN', { timeZone: timezone, hour12: false }),
    timezone,
  }
}

export function createCookieWarningScanner({ database, notify = deliverWebhook, clock = () => new Date(), onError = console.error }) {
  let inFlight = null
  const getAccount = (id) => database.prepare('SELECT * FROM accounts WHERE id = ?').get(id)

  async function scan() {
    const summary = { sent: 0, failed: 0, skipped: 0 }
    const candidates = database.prepare(`SELECT id FROM accounts
      WHERE enabled = 1 AND cookie_warning_enabled = 1 AND cookie_expires_at IS NOT NULL
        AND webhook_url IS NOT NULL AND webhook_url <> ''`).all()
    for (const { id } of candidates) {
      const account = getAccount(id)
      const now = clock()
      let due
      try { due = cookieWarningDue(account, now) } catch { summary.skipped += 1; continue }
      if (!due) continue
      let row = database.prepare(`SELECT * FROM cookie_warnings
        WHERE account_id = ? AND cookie_expires_at = ? AND phase = ? AND period_key = ?`)
        .get(id, account.cookie_expires_at, due.phase, due.periodKey)
      if (row?.status === 'sent' || (row && now.getTime() - Date.parse(row.last_attempt_at) < RETRY_INTERVAL_MS)) {
        summary.skipped += 1
        continue
      }
      if (!row) {
        const inserted = database.prepare(`INSERT INTO cookie_warnings
          (account_id, cookie_expires_at, phase, period_key, delivery_id, status, last_attempt_at)
          VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
          .run(id, account.cookie_expires_at, due.phase, due.periodKey, randomUUID(), now.toISOString())
        row = database.prepare('SELECT * FROM cookie_warnings WHERE id = ?').get(inserted.lastInsertRowid)
      } else {
        database.prepare("UPDATE cookie_warnings SET status = 'pending', last_attempt_at = ?, last_error = NULL WHERE id = ?")
          .run(now.toISOString(), row.id)
      }
      try {
        const result = await notify({
          url: account.webhook_url,
          secret: account.webhook_secret_enc ? decrypt(account.webhook_secret_enc) : '',
          event: 'glados.cookie.expiry',
          deliveryId: row.delivery_id,
          account: { id, label: account.label, email: account.email, cookieExpiresAt: account.cookie_expires_at },
          result: {
            status: due.phase === 'expired' ? 'cookie_expired' : 'cookie_expiring',
            message: due.phase === 'expired'
              ? `Cookie 已于 ${due.expiryLabel}（${due.timezone}）过期，请更新登录态。`
              : `Cookie 将在 ${due.remainingDays} 天内到期，过期时间：${due.expiryLabel}（${due.timezone}），请及时更新登录态。`,
            remainingDays: due.remainingDays,
            cookieExpiresAt: account.cookie_expires_at,
            checkedAt: row.last_attempt_at,
          },
          // Configuration may change while this delivery waits in the webhook queue.
          shouldSend: () => {
            const current = getAccount(id)
            const currentDue = cookieWarningDue(current, clock())
            return current?.cookie_expires_at === account.cookie_expires_at
              && current.webhook_url === account.webhook_url
              && current.webhook_secret_enc === account.webhook_secret_enc
              && currentDue?.phase === due.phase && currentDue.periodKey === due.periodKey
          },
        })
        if (result?.skipped) {
          database.prepare("DELETE FROM cookie_warnings WHERE id = ? AND status = 'pending'").run(row.id)
          summary.skipped += 1
        } else {
          database.prepare("UPDATE cookie_warnings SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?")
            .run(clock().toISOString(), row.id)
          summary.sent += 1
        }
      } catch (error) {
        const message = safeErrorMessage(error)
        database.prepare("UPDATE cookie_warnings SET status = 'failed', last_error = ?, last_attempt_at = ? WHERE id = ?")
          .run(message, clock().toISOString(), row.id)
        onError(`Cookie expiry warning failed for account ${id}: ${message}`)
        summary.failed += 1
      }
    }
    return summary
  }

  return function checkCookieWarnings() {
    if (!inFlight) inFlight = scan().finally(() => { inFlight = null })
    return inFlight
  }
}
