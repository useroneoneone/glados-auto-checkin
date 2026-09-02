import { chromium } from 'playwright'
import { config } from './config.js'
import { decrypt } from './crypto.js'

const LOGIN_URL = `${config.gladosOrigin}/login`
const CHECKIN_URL = `${config.gladosOrigin}/console/checkin`
const COOKIE_ATTRIBUTE_NAMES = new Set(['path', 'domain', 'expires', 'max-age', 'secure', 'httponly', 'samesite', 'priority'])

function summarizeCheckin(payload) {
  const text = JSON.stringify(payload || {})
  const already = /repeat|already|today|已签|签到过/i.test(text)
  const success = /checkin|success|got|observation|签到成功/i.test(text)
  return { already, success }
}

function formatDecimal(value) {
  if (value == null) return null
  return String(value).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '')
}

function parseCookieHeader(value) {
  const origin = new URL(config.gladosOrigin)
  const source = String(value || '').replace(/^cookie:\s*/i, '')
  const expiresAt = Date.parse(this?.account?.cookie_expires_at || '')
  return source.split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf('=')
      if (index < 1) return null
      const name = part.slice(0, index).trim()
      if (COOKIE_ATTRIBUTE_NAMES.has(name.toLowerCase())) return null
      return {
        name,
        value: part.slice(index + 1).trim(),
        domain: origin.hostname,
        path: '/',
        secure: origin.protocol === 'https:',
        httpOnly: false,
        sameSite: 'Lax',
        expires: Number.isFinite(expiresAt) ? Math.floor(expiresAt / 1000) : -1,
      }
    })
    .filter(Boolean)
}

function splitSessionCookies(account) {
  if (!account.cookie_sess_enc || !account.cookie_sess_sig_enc) return []
  const origin = new URL(config.gladosOrigin)
  const expiresAt = Date.parse(account.cookie_expires_at || '')
  const common = {
    domain: origin.hostname,
    path: '/',
    secure: origin.protocol === 'https:',
    httpOnly: true,
    sameSite: 'Lax',
    expires: Number.isFinite(expiresAt) ? Math.floor(expiresAt / 1000) : -1,
  }
  return [
    { ...common, name: 'koa:sess', value: decrypt(account.cookie_sess_enc) },
    { ...common, name: 'koa:sess.sig', value: decrypt(account.cookie_sess_sig_enc) },
  ].filter((cookie) => cookie.value)
}

export class GladosClient {
  constructor(account) {
    this.account = account
    this.context = null
    this.page = null
  }

  async open() {
    const options = { headless: true }
    if (!this.account.cookie_enc && !this.account.cookie_sess_enc && this.account.storage_state_enc) {
      try { options.storageState = JSON.parse(decrypt(this.account.storage_state_enc)) } catch { /* stale state */ }
    }
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    this.context = await browser.newContext(options)
    const sessionCookies = splitSessionCookies(this.account)
    if (sessionCookies.length === 2) {
      await this.context.addCookies(sessionCookies)
    } else if (this.account.cookie_enc) {
      const cookieHeader = decrypt(this.account.cookie_enc)
      const cookies = parseCookieHeader.call(this, cookieHeader)
      if (!cookies.length) throw new Error('Cookie 格式无效，请粘贴浏览器请求头里的 Cookie 字符串')
      await this.context.addCookies(cookies)
    }
    this.context.once('close', () => browser.close().catch(() => {}))
    this.page = await this.context.newPage()
    await this.page.goto(CHECKIN_URL, { waitUntil: 'commit', timeout: 60000 })
  }

  async status() {
    const response = await this.page.request.get(`${config.gladosOrigin}/api/user/status`, {
      headers: { Accept: 'application/json', Referer: `${config.gladosOrigin}/console/checkin` },
    })
    if (!response.ok()) return { loggedIn: !/\/login(?:\?|$)/.test(this.page.url()) }
    const json = await response.json().catch(() => ({}))
    const data = json?.data || json
    return { loggedIn: Boolean(data?.email || data?.isLogin || data?.loggedIn || data?.user || data?.username), data }
  }

  async loginWithOtp(code) {
    const emailInput = this.page.locator('input[type="email"], input[name*="email" i], input[placeholder*="邮箱" i]').first()
    if (await emailInput.count()) await emailInput.fill(this.account.email)
    const codeInput = this.page.locator('input[name*="code" i], input[placeholder*="验证码" i], input[inputmode="numeric"]').first()
    if (!(await codeInput.count())) throw new Error('找不到验证码输入框')
    await codeInput.fill(code)
    const loginButton = this.page.getByRole('button', { name: /登录|登陆|提交/i }).first()
    if (await loginButton.count()) await loginButton.click()
    else await codeInput.press('Enter')
    await this.page.waitForTimeout(1500)
    return this.status()
  }

  async requestOtp() {
    const emailInput = this.page.locator('input[type="email"], input[name*="email" i], input[placeholder*="邮箱" i]').first()
    if (!(await emailInput.count())) throw new Error('找不到邮箱输入框')
    await emailInput.fill(this.account.email)
    const sendButton = this.page.getByRole('button', { name: /验证码|发送|获取/i }).first()
    if (!(await sendButton.count())) throw new Error('找不到发送验证码按钮')
    await sendButton.click()
  }

  async checkin() {
    const expiresAt = Date.parse(this.account.cookie_expires_at || '')
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return { status: 'login_required', message: 'Cookie 已过期，请在后台更新' }
    const status = await this.status()
    if (!status.loggedIn) return { status: 'login_required', message: '登录状态已失效' }
    const pointsBefore = await this.page.request.get(`${config.gladosOrigin}/api/user/points`).then((r) => r.json().catch(() => ({})))
    let response = await this.page.request.post(`${config.gladosOrigin}/api/user/checkin`, {
      data: { token: config.gladosCheckinToken },
      headers: { Accept: 'application/json', Referer: `${config.gladosOrigin}/console/checkin` },
    })
    let payload = await response.json().catch(() => ({ message: `HTTP ${response.status()}` }))
    if (!response.ok() || !summarizeCheckin(payload).success) {
      // UI fallback for deployments where the console exposes actions without the public endpoint.
      const pointsLink = this.page.getByText('积分', { exact: true }).first()
      if (await pointsLink.count()) {
        await pointsLink.click().catch(() => {})
        const checkinButton = this.page.getByText('签到', { exact: true }).first()
        if (await checkinButton.count()) {
          await checkinButton.click().catch(() => {})
          await this.page.waitForTimeout(1200)
          response = await this.page.request.get(`${config.gladosOrigin}/api/user/points`)
          payload = await response.json().catch(() => ({ message: '已完成页面签到操作' }))
        }
      }
    }
    const result = summarizeCheckin(payload)
    const points = await this.page.request.get(`${config.gladosOrigin}/api/user/points`).then((r) => r.json().catch(() => pointsBefore))
    const pointsValue = points?.points ?? pointsBefore?.points ?? null
    const history = points?.history || []
    const change = history[0]?.change ?? null
    let state = result.already ? 'already_signed' : (result.success ? 'success' : 'failed')
    if (!response.ok() && state === 'success') state = 'failed'
    return {
      status: state,
      message: payload?.message || payload?.msg || payload?.data?.message || JSON.stringify(payload),
      points: formatDecimal(pointsValue),
      pointsChange: formatDecimal(change),
      leftDays: status.data?.leftDays == null ? null : String(status.data.leftDays).split('.')[0],
      raw: payload,
    }
  }

  async close() {
    await this.context?.close().catch(() => {})
  }
}
