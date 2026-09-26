import { config } from './config.js'
import { decrypt } from './crypto.js'
import { httpError, withRetry } from './retry.js'
import { safeErrorMessage } from './errors.js'

const CHECKIN_URL = `${config.gladosOrigin}/console/checkin`
const COOKIE_ATTRIBUTE_NAMES = new Set(['path', 'domain', 'expires', 'max-age', 'secure', 'httponly', 'samesite', 'priority'])
const REQUIRED_COOKIE_NAMES = ['koa:sess', 'koa:sess.sig', 'gld:sess', 'gld:sess.sig']

function checkinMessage(payload) {
  return String(payload?.message || payload?.msg || payload?.data?.message || '')
    .replace(/&#(?:x20|32);|&nbsp;/gi, ' ').trim()
}

function summarizeCheckin(payload) {
  const text = checkinMessage(payload)
  const already = /repeat|already|已签|签到过|today['’]s observation logged/i.test(text)
  const success = payload?.code != null
    ? Number(payload.code) === 0
    : payload?.success === true || (!/fail|error|invalid|失败/i.test(text) && /checkin!|success|got|observation|签到成功/i.test(text))
  return { already, success }
}

function formatDecimal(value) {
  if (value == null) return null
  return String(value).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '')
}

function cookieHeader(value) {
  return String(value || '').replace(/^cookie:\s*/i, '').split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf('=')
      if (index < 1) return null
      const name = part.slice(0, index).trim()
      const cookieValue = part.slice(index + 1).trim()
      if (COOKIE_ATTRIBUTE_NAMES.has(name.toLowerCase()) || !cookieValue) return null
      return `${name}=${cookieValue}`
    })
    .filter(Boolean)
    .join('; ')
}

function decryptCookieHeader(account) {
  if (!account.cookie_enc) return ''
  const value = cookieHeader(decrypt(account.cookie_enc))
  const names = new Set(value.split(';').map((part) => part.trim().split('=', 1)[0]))
  const missing = REQUIRED_COOKIE_NAMES.filter((name) => !names.has(name))
  if (!value || missing.length) throw new Error(`Cookie 格式无效，请重新读取完整四项 Cookie${missing.length ? `：${missing.join('、')}` : ''}`)
  return value
}

export class GladosClient {
  constructor(account) {
    this.account = account
    this.cookie = ''
    this.browser = null
  }

  async open() {
    if (Number(this.account.cookie_format_version) !== 4) throw new Error('Cookie 格式已升级，请重新导入完整的四项浏览器 Cookie')
    this.cookie = decryptCookieHeader(this.account)
    if (!this.cookie) throw new Error('未保存完整 Cookie，请用新版插件重新读取')
  }

  async requestJson(path, { method = 'GET', data } = {}) {
    const operation = async () => {
      const response = await fetch(`${config.gladosOrigin}${path}`, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(config.requestTimeoutMs),
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          Origin: config.gladosOrigin,
          Referer: CHECKIN_URL,
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
          Cookie: this.cookie,
          ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      })
      const status = response.status
      if (method === 'GET' && (status === 408 || status === 429 || status >= 500)) {
        throw httpError(path, status, response.headers.get('retry-after'))
      }
      if (!response.ok) return { ok: false, status, payload: null }
      const payload = await response.json().catch(() => { throw new Error(`${path} 返回的不是有效 JSON，请检查服务器网络或站点验证页面`) })
      return { ok: true, status, payload }
    }
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
    const loggedIn = (json?.code == null || Number(json.code) === 0)
      && Boolean(data?.email || data?.isLogin === true || data?.loggedIn === true || data?.user || data?.username)
    return { loggedIn, data, message: loggedIn ? '' : '登录态无效，请用新版插件重新读取完整 Cookie（koa:sess、koa:sess.sig、gld:sess、gld:sess.sig）' }
  }

  async checkin() {
    const expiresAt = Date.parse(this.account.cookie_expires_at || '')
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return { status: 'login_required', message: 'Cookie 已过期，请在后台更新' }
    const status = await this.status()
    if (!status.loggedIn) return { status: 'login_required', message: status.message || '登录状态已失效，请重新读取 Cookie' }
    let response
    try {
      response = await this.requestJson('/api/user/checkin', { method: 'POST', data: { token: config.gladosCheckinToken } })
    } catch (error) {
      return { status: 'failed', outcomeUnknown: true, message: `签到结果待确认，未自动重复提交，请稍后核实签到历史：${safeErrorMessage(error)}` }
    }
    if (response.status === 401) return { status: 'login_required', message: '登录状态已失效' }
    if (!response.ok) throw httpError('签到', response.status)
    const payload = response.payload
    const message = checkinMessage(payload)
    if (/automated check-in detected/i.test(message)) {
      return { status: 'login_required', reason: 'automated_checkin_detected', message: `站点拒绝了自动签到，请在官网重新登录并更新 Cookie。登录检测通过不代表允许签到。此次未重复提交。站点提示：${message}`, raw: payload }
    }
    const result = summarizeCheckin(payload)
    const state = result.already ? 'already_signed' : (result.success ? 'success' : 'failed')
    let points = {}
    const returnedHistory = payload?.list || payload?.data?.list
    const latest = Array.isArray(returnedHistory) ? returnedHistory[0] : null
    let pointsWarning = ''
    if (state !== 'failed' && latest?.balance == null) {
      try {
        const pointsResponse = await this.requestJson('/api/user/points')
        if (!pointsResponse.ok) throw httpError('积分查询', pointsResponse.status)
        points = pointsResponse.payload?.data || pointsResponse.payload || {}
      } catch (error) {
        pointsWarning = `；积分查询暂时失败（不影响签到结果）：${safeErrorMessage(error)}`
      }
    }
    const history = points.history || []
    const change = state === 'success' ? (payload?.points ?? latest?.change ?? history[0]?.change ?? null) : null
    return {
      status: state,
      message: `${message || JSON.stringify(payload)}${pointsWarning}`,
      points: formatDecimal(latest?.balance ?? points.points),
      pointsChange: formatDecimal(change),
      leftDays: status.data?.leftDays == null ? null : String(status.data.leftDays).split('.')[0],
      raw: payload,
    }
  }

  async close() { this.cookie = '' }
}
