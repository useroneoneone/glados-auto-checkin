import crypto from 'node:crypto'
import { config } from './config.js'
import { SerialQueue } from './jobs.js'
import { httpError, withRetry } from './retry.js'

const queue = new SerialQueue(1000)

export function deliverWebhook({ url, secret = '', event = 'glados.checkin', account, result, deliveryId = crypto.randomUUID(), shouldSend = () => true }) {
  if (!url) return Promise.resolve({ skipped: true })
  const target = new URL(url)
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Webhook URL 必须是 http 或 https 地址')
  const checkedAt = result?.checkedAt || new Date().toISOString()
  const statusLabels = {
    success: '签到成功', already_signed: '今日已签到', login_required: 'Cookie 已失效',
    failed: '签到失败', test: '测试成功',
    cookie_expiring: 'Cookie 即将到期', cookie_expired: 'Cookie 已过期',
  }
  const title = event === 'glados.cookie.expiry' ? 'GLaDOS Cookie 到期提醒'
    : event === 'glados.webhook.test' ? 'GLaDOS Webhook 测试' : 'GLaDOS 签到通知'
  const content = [
    title,
    `账号：${account?.label || account?.email || account?.id || '未知账号'}`,
    `状态：${statusLabels[result?.status] || result?.status || '未知'}`,
    result?.message ? `消息：${result.message}` : '',
    result?.points != null ? `当前积分：${String(result.points).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '')}` : '',
    `时间：${new Date(checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`,
  ].filter(Boolean).join('\n')
  let provider = 'generic'
  let body = { event, deliveryId, account, result: { ...result, checkedAt } }
  if (target.hostname === 'qyapi.weixin.qq.com' && target.pathname.includes('/cgi-bin/webhook/send')) {
    provider = 'wecom'
    body = { msgtype: 'text', text: { content } }
  } else if (target.hostname === 'open.feishu.cn' && target.pathname.includes('/open-apis/bot/')) {
    provider = 'feishu'
    body = { msg_type: 'text', content: { text: content } }
  } else if ((target.hostname === 'dingtalk.com' || target.hostname.endsWith('.dingtalk.com')) && target.pathname.includes('/robot/send')) {
    provider = 'dingtalk'
    body = { msgtype: 'text', text: { content } }
  }
  const headers = {
    'content-type': 'application/json',
    'x-glados-delivery-id': deliveryId,
    'idempotency-key': deliveryId,
  }
  const payload = JSON.stringify(body)
  if (secret) headers['x-glados-signature'] = crypto.createHmac('sha256', secret).update(payload).digest('hex')

  return queue.run(() => withRetry(async (attempt) => {
    if (!await shouldSend()) return { skipped: true }
    const response = await fetch(url, {
      method: 'POST', headers, body: payload, signal: AbortSignal.timeout(config.webhookTimeoutMs),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw httpError('Webhook', response.status, response.headers.get('retry-after'))
    }
    // Body reads use the same deadline; a stalled body is also a delivery failure.
    const responseText = await response.text()
    let json = null
    try { json = responseText ? JSON.parse(responseText) : null } catch { /* generic endpoints may return plain text */ }
    if (provider !== 'generic' && (!json || typeof json !== 'object')) throw new Error('Webhook 返回了无效的机器人响应')
    if (provider === 'wecom' && Number(json.errcode || 0) !== 0) throw new Error(`企业微信 Webhook 拒绝消息：${json.errmsg || json.errcode}`)
    if (provider === 'feishu' && Number(json.code || json.StatusCode || 0) !== 0) throw new Error(`飞书 Webhook 拒绝消息：${json.msg || json.StatusMessage || json.code}`)
    if (provider === 'dingtalk' && Number(json.errcode || 0) !== 0) throw new Error(`钉钉 Webhook 拒绝消息：${json.errmsg || json.errcode}`)
    return { status: response.status, provider, attempts: attempt, deliveryId }
  }, { attempts: config.webhookAttempts, delayMs: config.retryDelayMs }))
}
