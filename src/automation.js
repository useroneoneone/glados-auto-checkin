import cron from 'node-cron'
import crypto from 'node:crypto'
import { db } from './db.js'
import { decrypt } from './crypto.js'
import { GladosClient } from './glados.js'

const active = new Set()

function safeErrorMessage(error) {
  return String(error?.message || error || '未知错误')
    .replace(/koa:sess(?:\.sig)?=[^;\s]+/gi, 'koa:sess=[已隐藏]')
    .split('\n')
    .filter((line) => !/^\s*-\s*cookie:/i.test(line))
    .join('\n')
    .slice(0, 500)
}

async function deliverWebhook({ url, secret = '', event = 'glados.checkin', account, result }) {
  if (!url) return { skipped: true }
  const target = new URL(url)
  const checkedAt = new Date().toISOString()
  const statusLabels = {
    success: '签到成功',
    already_signed: '今日已签到',
    login_required: 'Cookie 已失效',
    failed: '签到失败',
    test: '测试成功',
  }
  const content = [
    event === 'glados.webhook.test' ? 'GLaDOS Webhook 测试' : 'GLaDOS 签到通知',
    `账号：${account?.label || account?.email || account?.id || '未知账号'}`,
    `状态：${statusLabels[result?.status] || result?.status || '未知'}`,
    result?.message ? `消息：${result.message}` : '',
    result?.points ? `当前积分：${String(result.points).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '')}` : '',
    `时间：${new Date(checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`,
  ].filter(Boolean).join('\n')
  let provider = 'generic'
  let body = {
    event,
    account,
    result: { ...result, checkedAt },
  }
  if (target.hostname === 'qyapi.weixin.qq.com' && target.pathname.includes('/cgi-bin/webhook/send')) {
    provider = 'wecom'
    body = { msgtype: 'text', text: { content } }
  } else if (target.hostname === 'open.feishu.cn' && target.pathname.includes('/open-apis/bot/')) {
    provider = 'feishu'
    body = { msg_type: 'text', content: { text: content } }
  } else if (target.hostname.endsWith('dingtalk.com') && target.pathname.includes('/robot/send')) {
    provider = 'dingtalk'
    body = { msgtype: 'text', text: { content } }
  }
  const headers = { 'content-type': 'application/json' }
  const payload = JSON.stringify(body)
  if (secret) headers['x-glados-signature'] = crypto.createHmac('sha256', secret).update(payload).digest('hex')
  const response = await fetch(url, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(15000) })
  const responseText = await response.text().catch(() => '')
  if (!response.ok) throw new Error(`Webhook HTTP ${response.status}${responseText ? `: ${responseText.slice(0, 160)}` : ''}`)
  let responseJson = null
  try { responseJson = responseText ? JSON.parse(responseText) : null } catch { /* generic endpoints may return plain text */ }
  if (provider === 'wecom' && Number(responseJson?.errcode || 0) !== 0) throw new Error(`企业微信 Webhook 拒绝消息：${responseJson?.errmsg || responseText}`)
  if (provider === 'feishu' && Number(responseJson?.code || responseJson?.StatusCode || 0) !== 0) throw new Error(`飞书 Webhook 拒绝消息：${responseJson?.msg || responseJson?.StatusMessage || responseText}`)
  if (provider === 'dingtalk' && Number(responseJson?.errcode || 0) !== 0) throw new Error(`钉钉 Webhook 拒绝消息：${responseJson?.errmsg || responseText}`)
  return { status: response.status, provider }
}

async function postWebhook(account, result) {
  if (!account.webhook_url) return
  return deliverWebhook({
    url: account.webhook_url,
    secret: account.webhook_secret_enc ? decrypt(account.webhook_secret_enc) : '',
    account: { id: account.id, label: account.label, email: account.email, cookieExpiresAt: account.cookie_expires_at },
    result,
  })
}

export async function testWebhook({ url, secret = '', label = 'Webhook 测试' }) {
  return deliverWebhook({
    url,
    secret,
    event: 'glados.webhook.test',
    account: { id: null, label },
    result: { status: 'test', message: 'Webhook 测试消息' },
  })
}

function recordWebhookError(accountId, checkinId, result, error) {
  const webhookError = safeErrorMessage(error)
  result.webhookError = webhookError
  const message = `${result.message || result.status || '执行完成'}；Webhook 推送失败：${webhookError}`.slice(0, 500)
  db.prepare('UPDATE accounts SET last_message = ? WHERE id = ?').run(message, accountId)
  if (checkinId) db.prepare('UPDATE checkins SET message = ? WHERE id = ?').run(message, checkinId)
  console.error(`Webhook failed for account ${accountId}: ${webhookError}`)
}

export async function runAccount(accountId) {
  if (active.has(accountId)) return { status: 'skipped', message: '该账号正在执行' }
  active.add(accountId)
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId)
  if (!account) throw new Error('账号不存在')
  let result
  let client
  try {
    const expiresAt = Date.parse(account.cookie_expires_at || '')
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      result = { status: 'login_required', message: 'Cookie 已过期，请在后台更新' }
      const now = new Date().toISOString()
      db.prepare('UPDATE accounts SET last_status = ?, last_message = ?, last_checked_at = ?, updated_at = ? WHERE id = ?')
        .run(result.status, result.message, now, now, accountId)
      const checkin = db.prepare('INSERT INTO checkins (account_id, status, message, checked_at) VALUES (?, ?, ?, ?)')
        .run(accountId, result.status, result.message, now)
      try { await postWebhook(account, result) } catch (error) { recordWebhookError(accountId, checkin.lastInsertRowid, result, error) }
      return result
    }
    client = new GladosClient(account)
    await client.open()
    result = await client.checkin()
    if (result.status === 'login_required') {
      result.message = result.message || 'Cookie 已失效，请在后台更新'
    }
    const now = new Date().toISOString()
    db.prepare('UPDATE accounts SET last_status = ?, last_message = ?, last_checked_at = ?, updated_at = ? WHERE id = ?')
      .run(result.status, result.message || '', now, now, accountId)
    const checkin = db.prepare('INSERT INTO checkins (account_id, status, message, points, points_change, left_days, raw_json, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(accountId, result.status, result.message || '', result.points || null, result.pointsChange || null, result.leftDays || null, JSON.stringify(result.raw || {}), now)
    try { await postWebhook(account, result) } catch (error) { recordWebhookError(accountId, checkin.lastInsertRowid, result, error) }
    return result
  } catch (error) {
    const message = safeErrorMessage(error)
    result = { status: 'failed', message }
    const now = new Date().toISOString()
    db.prepare('UPDATE accounts SET last_status = ?, last_message = ?, last_checked_at = ?, updated_at = ? WHERE id = ?').run('failed', message, now, now, accountId)
    const checkin = db.prepare('INSERT INTO checkins (account_id, status, message, checked_at) VALUES (?, ?, ?, ?)').run(accountId, 'failed', message, now)
    try { await postWebhook(account, result) } catch (webhookError) { recordWebhookError(accountId, checkin.lastInsertRowid, result, webhookError) }
    return result
  } finally {
    await client?.close()
    active.delete(accountId)
  }
}

export async function loginAccount(accountId) {
  if (active.has(accountId)) return { status: 'skipped', message: '该账号正在执行' }
  active.add(accountId)
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId)
  if (!account) throw new Error('账号不存在')
  const client = new GladosClient(account)
  try {
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
    db.prepare('UPDATE accounts SET last_status = ?, last_message = ?, last_checked_at = ?, updated_at = ? WHERE id = ?').run('login_failed', message, now, now, accountId)
    throw new Error(message)
  } finally {
    await client.close()
    active.delete(accountId)
  }
}

function scheduleParts(timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).map((part) => [part.type, part.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` }
}

export function startScheduler() {
  return cron.schedule('* * * * *', async () => {
    const accounts = db.prepare('SELECT * FROM accounts WHERE enabled = 1').all()
    for (const account of accounts) {
      let current
      try { current = scheduleParts(account.schedule_timezone || 'Asia/Shanghai') } catch { continue }
      if (current.time !== (account.schedule_time || '07:15')) continue
      const claimed = db.prepare(`UPDATE accounts SET last_scheduled_date = ?
        WHERE id = ? AND (last_scheduled_date IS NULL OR last_scheduled_date <> ?)`).run(current.date, account.id, current.date)
      if (claimed.changes) runAccount(account.id).catch((error) => console.error(`Scheduled check-in failed for account ${account.id}:`, error))
    }
  })
}
