import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { config } from './config.js'

const CHECKIN_URL = `${config.gladosOrigin}/console/checkin`

function summarize(payload) {
  const message = String(payload?.message || payload?.msg || payload?.data?.message || '')
    .replace(/&#(?:x20|32);|&nbsp;/gi, ' ').trim()
  const already = /repeat|already|已签|签到过|today['’]s observation logged/i.test(message)
  const success = Number(payload?.code) === 0 || payload?.success === true
  return { message, status: already ? 'already_signed' : success ? 'success' : 'failed' }
}

function profilePath(accountId) {
  const id = Number(accountId)
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('无效账号')
  return path.join(config.browserProfilesPath, `account-${id}`)
}

export class BrowserCheckinManager {
  constructor({ launch = (...args) => chromium.launchPersistentContext(...args), headless = config.browserHeadless } = {}) {
    this.launch = launch
    this.headless = headless
    this.sessions = new Map()
  }

  async open(account, { keepOpen = false } = {}) {
    const existing = this.sessions.get(account.id)
    if (existing) return { ...existing, reused: true }
    const userDataDir = profilePath(account.id)
    fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 })
    const context = await this.launch(userDataDir, {
      headless: this.headless,
      viewport: { width: 1365, height: 768 },
      locale: 'zh-CN',
      timezoneId: account.schedule_timezone || 'Asia/Shanghai',
    })
    const page = context.pages()[0] || await context.newPage()
    const session = { context, page, persistent: keepOpen }
    this.sessions.set(account.id, session)
    return session
  }

  async beginLogin(account) {
    const session = await this.open(account, { keepOpen: true })
    await session.page.goto(CHECKIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    return { profile: `account-${account.id}`, url: CHECKIN_URL, reused: session.reused || false }
  }

  async checkin(account) {
    const session = await this.open(account)
    try {
      await session.page.goto(CHECKIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
      const button = session.page.getByRole('button', { name: /^签到$/ }).first()
      if (!(await button.count())) return { status: 'login_required', message: '浏览器档案未登录，请打开浏览器登录后重试' }
      const [response] = await Promise.all([
        session.page.waitForResponse((candidate) => new URL(candidate.url()).pathname === '/api/user/checkin' && candidate.request().method() === 'POST', { timeout: config.requestTimeoutMs }),
        button.click(),
      ])
      const payload = await response.json().catch(() => null)
      if (!response.ok() || !payload) throw new Error(`签到 HTTP ${response.status()}`)
      const result = summarize(payload)
      if (/automated check-in detected/i.test(result.message)) {
        return { status: 'login_required', reason: 'automated_checkin_detected', message: `站点拒绝了浏览器签到，请打开浏览器重新登录后重试。站点提示：${result.message}`, raw: payload }
      }
      return { ...result, pointsChange: result.status === 'success' ? String(payload.points ?? '') || null : null, raw: payload }
    } finally {
      if (!session.persistent) await this.close(account.id)
    }
  }

  async close(accountId) {
    const session = this.sessions.get(accountId)
    this.sessions.delete(accountId)
    await session?.context.close().catch(() => {})
  }

  async closeAll() {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)))
  }
}
