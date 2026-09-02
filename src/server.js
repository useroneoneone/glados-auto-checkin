import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import express from 'express'
import session from 'express-session'
import bcrypt from 'bcryptjs'
import { config } from './config.js'
import { db, accountPublic } from './db.js'
import { encrypt } from './crypto.js'
import { loginAccount, runAccount, startScheduler, testWebhook } from './automation.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(express.json({ limit: '100kb' }))
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 1000 * 60 * 60 * 12 },
}))
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'")
  next()
})

const requireAuth = (req, res, next) => req.session.admin ? next() : res.status(401).json({ error: '未登录' })
const getAccount = (id) => db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(id))
const text = (value, fallback = '') => String(value ?? fallback).trim()
const dateOrNull = (value) => {
  const raw = text(value)
  if (!raw) return null
  const time = Date.parse(raw)
  if (!Number.isFinite(time)) throw new Error('Cookie 过期时间格式无效')
  return new Date(time).toISOString()
}
const scheduleTime = (value, fallback = '07:15') => {
  const raw = text(value, fallback)
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw)) throw new Error('定时时间格式无效')
  return raw
}
const scheduleTimezone = (value, fallback = 'Asia/Shanghai') => {
  const raw = text(value, fallback)
  try { new Intl.DateTimeFormat('en', { timeZone: raw }).format() } catch { throw new Error('时区无效') }
  return raw
}
const webhookUrl = (value) => {
  const raw = text(value)
  if (!raw) return null
  try { if (!['http:', 'https:'].includes(new URL(raw).protocol)) throw new Error() } catch { throw new Error('Webhook URL 必须是 http 或 https 地址') }
  return raw
}

const jobs = new Map()
function startJob(type, accountId, operation) {
  const id = randomUUID()
  const job = { id, type, accountId, status: 'queued', createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, result: null, error: null }
  jobs.set(id, job)
  setImmediate(async () => {
    job.status = 'running'
    job.startedAt = new Date().toISOString()
    try {
      job.result = await operation()
      job.status = 'completed'
    } catch (error) {
      job.error = error.message
      job.status = 'failed'
    } finally {
      job.finishedAt = new Date().toISOString()
      setTimeout(() => jobs.delete(id), 30 * 60 * 1000).unref()
    }
  })
  return job
}
const loginAttempts = new Map()
const authRateLimit = (req, res, next) => {
  const key = req.ip || 'unknown'
  const now = Date.now()
  const recent = (loginAttempts.get(key) || []).filter((time) => now - time < 10 * 60 * 1000)
  if (recent.length >= 10) return res.status(429).json({ error: '登录尝试过于频繁，请稍后再试' })
  recent.push(now)
  loginAttempts.set(key, recent)
  next()
}

app.post('/api/auth/login', authRateLimit, async (req, res) => {
  const username = text(req.body?.username)
  const password = String(req.body?.password || '')
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username)
  if (!admin || !await bcrypt.compare(password, admin.password_hash)) return res.status(401).json({ error: '账号或密码错误' })
  req.session.admin = { id: admin.id, username: admin.username }
  res.json({ user: req.session.admin })
})
app.post('/api/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })))
app.get('/api/auth/me', (req, res) => req.session.admin ? res.json({ user: req.session.admin }) : res.status(401).json({ error: '未登录' }))

app.get('/api/accounts', requireAuth, (req, res) => res.json({ accounts: db.prepare('SELECT * FROM accounts ORDER BY id DESC').all().map(accountPublic) }))
app.post('/api/accounts', requireAuth, (req, res) => {
  const body = req.body || {}
  if (!text(body.label) || !text(body.sess) || !text(body.sessSig)) return res.status(400).json({ error: '请填写显示名称、koa:sess 和 koa:sess.sig' })
  let cookieExpiresAt = null
  let accountWebhookUrl = null
  let accountScheduleTime
  let accountScheduleTimezone
  try {
    cookieExpiresAt = dateOrNull(body.cookieExpiresAt)
    accountWebhookUrl = webhookUrl(body.webhookUrl)
    accountScheduleTime = scheduleTime(body.scheduleTime)
    accountScheduleTimezone = scheduleTimezone(body.scheduleTimezone)
  } catch (error) { return res.status(400).json({ error: error.message }) }
  const now = new Date().toISOString()
  const result = db.prepare(`INSERT INTO accounts (label, email, imap_host, imap_port, imap_secure, imap_user, imap_password_enc, webhook_url, webhook_secret_enc, cookie_enc, cookie_sess_enc, cookie_sess_sig_enc, cookie_expires_at, schedule_time, schedule_timezone, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    text(body.label), text(body.email), '', 993, 1, '', '',
    accountWebhookUrl, text(body.webhookSecret) ? encrypt(body.webhookSecret) : null,
    null, encrypt(text(body.sess)), encrypt(text(body.sessSig)), cookieExpiresAt,
    accountScheduleTime, accountScheduleTimezone, body.enabled === false ? 0 : 1, now, now,
  )
  res.status(201).json({ account: accountPublic(getAccount(result.lastInsertRowid)) })
})
app.put('/api/accounts/:id', requireAuth, (req, res) => {
  const account = getAccount(req.params.id)
  if (!account) return res.status(404).json({ error: '账号不存在' })
  const body = req.body || {}
  let cookieExpiresAt = account.cookie_expires_at
  let accountWebhookUrl = account.webhook_url
  let accountScheduleTime = account.schedule_time || '07:15'
  let accountScheduleTimezone = account.schedule_timezone || 'Asia/Shanghai'
  try {
    if (body.cookieExpiresAt !== undefined) cookieExpiresAt = dateOrNull(body.cookieExpiresAt)
    if (body.webhookUrl !== undefined) accountWebhookUrl = webhookUrl(body.webhookUrl)
    if (body.scheduleTime !== undefined) accountScheduleTime = scheduleTime(body.scheduleTime)
    if (body.scheduleTimezone !== undefined) accountScheduleTimezone = scheduleTimezone(body.scheduleTimezone)
  } catch (error) { return res.status(400).json({ error: error.message }) }
  const now = new Date().toISOString()
  const sessEnc = text(body.sess) ? encrypt(text(body.sess)) : account.cookie_sess_enc
  const sessSigEnc = text(body.sessSig) ? encrypt(text(body.sessSig)) : account.cookie_sess_sig_enc
  const secretEnc = body.webhookSecret === '' ? null : (text(body.webhookSecret) ? encrypt(body.webhookSecret) : account.webhook_secret_enc)
  const enabled = body.enabled === false ? 0 : 1
  const scheduleChanged = accountScheduleTime !== account.schedule_time || accountScheduleTimezone !== account.schedule_timezone || enabled !== account.enabled
  const lastScheduledDate = scheduleChanged ? null : account.last_scheduled_date
  db.prepare(`UPDATE accounts SET label=?, email=?, webhook_url=?, webhook_secret_enc=?, cookie_sess_enc=?, cookie_sess_sig_enc=?, cookie_expires_at=?, schedule_time=?, schedule_timezone=?, enabled=?, last_scheduled_date=?, updated_at=? WHERE id=?`).run(
    text(body.label, account.label), text(body.email, account.email), accountWebhookUrl, secretEnc,
    sessEnc, sessSigEnc, cookieExpiresAt, accountScheduleTime, accountScheduleTimezone,
    enabled, lastScheduledDate, now, account.id,
  )
  res.json({ account: accountPublic(getAccount(account.id)) })
})
app.delete('/api/accounts/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM accounts WHERE id = ?').run(Number(req.params.id))
  res.json({ ok: true })
})
app.post('/api/accounts/:id/login', requireAuth, (req, res) => {
  const accountId = Number(req.params.id)
  if (!getAccount(accountId)) return res.status(404).json({ error: '账号不存在' })
  const job = startJob('login', accountId, () => loginAccount(accountId))
  res.status(202).json({ job: { id: job.id, status: job.status } })
})
app.post('/api/accounts/:id/checkin', requireAuth, (req, res) => {
  const accountId = Number(req.params.id)
  if (!getAccount(accountId)) return res.status(404).json({ error: '账号不存在' })
  const job = startJob('checkin', accountId, () => runAccount(accountId))
  res.status(202).json({ job: { id: job.id, status: job.status } })
})
app.get('/api/jobs/:id', requireAuth, (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: '任务不存在或已过期' })
  res.json({ job })
})
app.post('/api/webhooks/test', requireAuth, async (req, res) => {
  try {
    const url = webhookUrl(req.body?.webhookUrl)
    if (!url) return res.status(400).json({ error: '请填写 Webhook URL' })
    const result = await testWebhook({ url, secret: text(req.body?.webhookSecret), label: text(req.body?.label, 'Webhook 测试') })
    res.json({ result })
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})
app.get('/api/checkins', requireAuth, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500)
  const rows = db.prepare(`SELECT c.*, a.label, a.email FROM checkins c JOIN accounts a ON a.id=c.account_id ORDER BY c.id DESC LIMIT ?`).all(limit)
  res.json({ checkins: rows })
})

app.use(express.static(path.join(__dirname, '..', 'public')))
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')))

app.listen(config.port, () => {
  console.log(`GLaDOS auto check-in listening on http://0.0.0.0:${config.port}`)
  startScheduler()
})
