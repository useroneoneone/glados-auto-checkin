import { chromium, request } from 'playwright'
import { config } from './config.js'
import { decrypt } from './crypto.js'
import { httpError, withRetry } from './retry.js'
import { safeErrorMessage } from './errors.js'

const CHECKIN_URL = `${config.gladosOrigin}/console/checkin`
const COOKIE_ATTRIBUTE_NAMES = new Set(['path', 'domain', 'expires', 'max-age', 'secure', 'httponly', 'samesite', 'priority'])

function summarizeCheckin(payload) {
  const text = String(payload?.message || payload?.msg || payload?.data?.message || '')
  const already = /repeat|already|已签|签到过/i.test(text)
  const success = payload?.code != null
    ? Number(payload.code) === 0
    : payload?.success === true || (!/fail|error|invalid|失败/i.test(text) && /checkin!|success|got|observation|签到成功/i.test(text))
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
    this.browser = null
    this.api = null
    this.context = null
    this.page = null
  }

  async open() {
    const options = {
      timeout: config.requestTimeoutMs,
      extraHTTPHeaders: { Accept: 'application/json', Referer: CHECKIN_URL },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.7339.16 Safari/537.36',
    }
    if (!this.account.cookie_enc && !this.account.cookie_sess_enc && this.account.storage_state_enc) {
      try { options.storageState = JSON.parse(decrypt(this.account.storage_state_enc)) } catch { /* stale state */ }
    }
    const sessionCookies = splitSessionCookies(this.account)
    if (sessionCookies.length === 2) {
      options.storageState = { cookies: sessionCookies, origins: [] }
    } else if (this.account.cookie_enc) {
      const cookieHeader = decrypt(this.account.cookie_enc)
      const cookies = parseCookieHeader.call(this, cookieHeader)
      if (!cookies.length) throw new Error('Cookie 格式无效，请粘贴浏览器请求头里的 Cookie 字符串')
      options.storageState = { cookies, origins: [] }
    }
    this.api = await request.newContext(options)
  }

  async openPage() {
    if (this.page) return
    this.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    this.context = await this.browser.newContext({ storageState: await this.api.storageState() })
    this.context.setDefaultTimeout(config.requestTimeoutMs)
    await this.context.route('**/*', (route) => (
      ['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue()
    ))
    this.page = await this.context.newPage()
    await this.page.goto(CHECKIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  }

  async requestJson(path, { method = 'GET', data } = {}) {
    const operation = async () => {
      const response = await this.api.fetch(`${config.gladosOrigin}${path}`, {
        method, data, timeout: config.requestTimeoutMs, maxRetries: 0,
      })
      try {
        const status = response.status()
        if (method === 'GET' && (status === 408 || status === 429 || status >= 500)) {
          throw httpError(path, status, response.headers()['retry-after'])
        }
        if (!response.ok()) return { ok: false, status, payload: null }
        const payload = await response.json().catch(() => { throw new Error(`${path} 返回的不是有效 JSON，请检查服务器网络或站点验证页面`) })
        return { ok: true, status, payload }
      } finally {
        await response.dispose()
      }
    }
    // A timed-out POST may already have succeeded remotely. Never replay it automatically.
    return method === 'GET'
      ? withRetry(operation, { attempts: config.requestAttempts, delayMs: config.retryDelayMs })
      : operation()
  }

  async status() {
    const response = await this.requestJson('/api/user/status')
    if (response.status === 401) return { loggedIn: false }
    if (!response.ok) throw httpError('登录态检测', response.status)
    const json = response.payload
    const data = json?.data || json
    return { loggedIn: Boolean(data?.email || data?.isLogin || data?.loggedIn || data?.user || data?.username), data }
  }

  async loginWithOtp(code) {
    await this.openPage()
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
    await this.openPage()
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
    let response
    try {
      response = await this.requestJson('/api/user/checkin', {
        method: 'POST', data: { token: config.gladosCheckinToken },
      })
      if ([404, 405].includes(response.status)) response = await this.checkinViaPage()
    } catch (error) {
      return {
        status: 'failed', outcomeUnknown: true,
        message: `签到结果待确认，未自动重复提交，请稍后核实签到历史：${safeErrorMessage(error)}`,
      }
    }
    if (response.status === 401) return { status: 'login_required', message: '登录状态已失效' }
    if (!response.ok) throw httpError('签到', response.status)
    const payload = response.payload
    const result = summarizeCheckin(payload)
    const state = result.already ? 'already_signed' : (result.success ? 'success' : 'failed')
    let points = {}
    let pointsWarning = ''
    if (state !== 'failed') {
      try {
        const response = await this.requestJson('/api/user/points')
        if (!response.ok) throw httpError('积分查询', response.status)
        points = response.payload?.data || response.payload || {}
      } catch (error) {
        pointsWarning = `；积分查询暂时失败（不影响签到结果）：${safeErrorMessage(error)}`
      }
    }
    const history = points.history || []
    const change = history[0]?.change ?? null
    return {
      status: state,
      message: `${payload?.message || payload?.msg || payload?.data?.message || JSON.stringify(payload)}${pointsWarning}`,
      points: formatDecimal(points.points),
      pointsChange: formatDecimal(change),
      leftDays: status.data?.leftDays == null ? null : String(status.data.leftDays).split('.')[0],
      raw: payload,
    }
  }

  async checkinViaPage() {
    await this.openPage()
    const pointsLink = this.page.getByText('积分', { exact: true }).first()
    if (await pointsLink.count()) await pointsLink.click()
    const [response] = await Promise.all([
      this.page.waitForResponse((response) => (
        new URL(response.url()).pathname === '/api/user/checkin' && response.request().method() === 'POST'
      ), { timeout: config.requestTimeoutMs }),
      this.page.getByText('签到', { exact: true }).first().click(),
    ])
    return { ok: response.ok(), status: response.status(), payload: await response.json() }
  }

  async close() {
    await this.context?.close().catch(() => {})
    await this.browser?.close().catch(() => {})
    await this.api?.dispose().catch(() => {})
    this.page = this.context = this.browser = this.api = null
  }
}
