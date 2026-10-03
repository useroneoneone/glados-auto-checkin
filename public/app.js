import { createAnimatedLoginMarkup, mountAnimatedLogin } from './animated-login.js'

const app = document.querySelector('#app')
let state = { user: null, accounts: [], checkins: [], view: 'overview', modal: false, editing: null, jobs: {} }
let loginCleanup = null

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const fmt = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
const fmtPoints = (value) => {
  if (value === null || value === undefined || value === '') return '—'
  const raw = String(value)
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return raw
  return raw.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '')
}
const toLocalInput = (value) => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 16)
}
const badge = (status) => {
  const map = {
    success: ['成功', 'badge-success'],
    already_signed: ['已签到', 'badge-warn'],
    failed: ['失败', 'badge-error'],
    login_required: ['Cookie 失效', 'badge-warn'],
    logged_in: ['Cookie 有效', 'badge-success'],
    login_failed: ['检测失败', 'badge-error'],
  }
  const [label, cls] = map[status] || ['未执行', 'badge-muted']
  return `<span class="badge ${cls}">${label}</span>`
}
async function api(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || '请求失败')
  return data
}
function toast(message) {
  const node = document.createElement('div')
  node.className = 'toast'
  node.setAttribute('role', 'status')
  node.textContent = message
  document.body.append(node)
  setTimeout(() => node.remove(), 6000)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function jobLabel(job) {
  if (!job) return ''
  if (job.status === 'queued') return '排队'
  if (job.status === 'notifying') return '推送'
  return job.type === 'login' ? '检测' : '签到'
}

async function waitJob(id, onProgress = () => {}) {
  let errors = 0
  while (state.user) {
    await sleep(1500)
    let job
    try {
      ;({ job } = await api(`/api/jobs/${id}`))
      errors = 0
    } catch (error) {
      if (++errors >= 5) throw new Error(`任务状态查询中断，任务仍可能在后台执行，请刷新查看：${error.message}`)
      continue
    }
    onProgress(job)
    if (job.status === 'completed') return job.result
    if (job.status === 'failed') throw new Error(job.error || '任务失败')
  }
  throw new Error('已退出登录，后台任务继续执行')
}
function readBrowserCookie() {
  return new Promise((resolve, reject) => {
    const requestId = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`
    const timeout = setTimeout(() => {
      window.removeEventListener('message', receive)
      reject(new Error('未连接 GLaDOS Cookie Helper，请确认已安装 1.9.0 或更新版本；点击插件图标授权当前后台网站，再刷新后台重试'))
    }, 6000)
    function receive(event) {
      const message = event.data
      if (event.source !== window || event.origin !== window.location.origin) return
      if (!message || message.source !== 'glados-cookie-helper' || message.type !== 'GLADOS_COOKIE_IMPORT_RESPONSE' || message.requestId !== requestId) return
      clearTimeout(timeout)
      window.removeEventListener('message', receive)
      if (!message.ok) reject(new Error(message.error || '读取浏览器 Cookie 失败'))
      else resolve(message.data)
    }
    window.addEventListener('message', receive)
    window.postMessage({
      source: 'glados-checkin-console',
      type: 'GLADOS_COOKIE_IMPORT_REQUEST',
      requestId,
    }, window.location.origin)
  })
}
async function runJob(url, accountId, label) {
  if (state.jobs[accountId]) return
  state.jobs[accountId] = '排队'
  renderShell()
  try {
    const created = await api(url, { method: 'POST' })
    const result = await waitJob(created.job.id, (job) => {
      const nextLabel = jobLabel(job)
      if (state.jobs[accountId] !== nextLabel) {
        state.jobs[accountId] = nextLabel
        if (!state.modal && state.user) renderShell()
      }
    })
    delete state.jobs[accountId]
    if (!state.user) return
    await loadData()
    if (!state.modal) renderShell()
    toast(result?.webhookError ? `${result.message}；Webhook 推送失败：${result.webhookError}` : result?.message || `${label}完成`)
  } catch (error) {
    delete state.jobs[accountId]
    if (!state.user) return
    await loadData().catch(() => {})
    if (!state.modal) renderShell()
    toast(error.message)
  }
}
function renderLogin(error = '') {
  loginCleanup?.()
  app.innerHTML = createAnimatedLoginMarkup(error)
  loginCleanup = mountAnimatedLogin(app.querySelector('.acl-login'))
  document.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = event.currentTarget
    const submit = form.querySelector('[type="submit"]')
    if (submit.disabled) return
    form.querySelector('.acl-error')?.remove()
    submit.disabled = true
    submit.textContent = '登录中...'
    try {
      const credentials = Object.fromEntries(new FormData(form))
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify(credentials) })
      await boot()
    } catch (e) {
      const notice = document.createElement('p')
      notice.className = 'acl-error'
      notice.setAttribute('role', 'alert')
      notice.textContent = e.message
      submit.before(notice)
      submit.disabled = false
      submit.textContent = '登 录'
    }
  })
}
async function loadData() {
  const [accounts, checkins] = await Promise.all([api('/api/accounts'), api('/api/checkins?limit=100')])
  state.accounts = accounts.accounts
  state.checkins = checkins.checkins
}
function renderShell() {
  loginCleanup?.()
  loginCleanup = null
  const focusKey = document.activeElement?.dataset
  const success = state.checkins.filter((item) => item.status === 'success' || item.status === 'already_signed').length
  const active = state.accounts.filter((item) => item.enabled).length
  app.innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><div class="brand-mark">G</div><span>GLaDOS Console</span></div><nav class="nav"><button data-view="overview" class="${state.view === 'overview' ? 'active' : ''}">总览</button><button data-view="accounts" class="${state.view === 'accounts' ? 'active' : ''}">账号管理</button><button data-view="history" class="${state.view === 'history' ? 'active' : ''}">签到历史</button></nav><div class="sidebar-foot">每个账号可独立设置<br/>随机入队开始时间与时区</div></aside><main class="main"><header class="topbar"><h1>${state.view === 'overview' ? '运行总览' : state.view === 'accounts' ? '账号管理' : '签到历史'}</h1><div class="topbar-actions"><button class="btn btn-ghost" data-refresh>刷新数据</button><button id="logout" class="btn btn-ghost">退出登录</button></div></header><section class="content">${state.view === 'overview' ? overview(success, active) : state.view === 'accounts' ? accountsView() : historyView()}</section></main></div>${state.modal ? accountModal() : ''}`
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => { state.view = button.dataset.view; renderShell() }))
  document.querySelector('#logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); state.user = null; renderLogin() })
  bindActions()
  document.body.classList.toggle('modal-open', state.modal)
  if (state.modal) {
    const dialog = document.querySelector('[role="dialog"]')
    app.querySelector('.shell').inert = true
    dialog.querySelector('[data-close]').focus()
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeModal() }
      if (event.key !== 'Tab') return
      const focusable = [...dialog.querySelectorAll('button, a[href], input, select, summary')].filter((el) => !el.disabled && el.getClientRects().length)
      const first = focusable[0], last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    })
  } else if (focusKey) {
    for (const key of ['view', 'edit', 'login', 'checkin', 'add', 'refresh']) {
      if (focusKey[key] !== undefined) {
        [...document.querySelectorAll(`[data-${key}]`)].find((el) => el.dataset[key] === focusKey[key])?.focus({ preventScroll: true })
        break
      }
    }
  }
}
function closeModal() {
  if (document.querySelector('#account-form [type="submit"]')?.disabled) return
  if (state.dirty && !confirm('尚有未保存的修改，确定关闭吗？')) return
  const id = state.editing?.id
  state.modal = false
  state.dirty = false
  renderShell()
  document.querySelector(id ? `[data-edit="${id}"]` : '[data-add]')?.focus()
}
function overview(success, active) {
  return `<div class="grid stats"><article class="stat"><div class="label">全部账号</div><div class="value">${state.accounts.length}</div></article><article class="stat"><div class="label">已启用定时</div><div class="value">${active}</div></article><article class="stat"><div class="label">成功记录 · 最近 100 条</div><div class="value">${success}</div></article><article class="stat"><div class="label">最近一次运行</div><div class="value" style="font-size:16px">${fmt(state.checkins[0]?.checked_at)}</div></article></div><div class="grid" style="margin-top:18px"><section class="panel"><div class="panel-head"><div><h2>账号状态</h2><p class="section-note">查看登录状态、定时计划与最近一次结果。</p></div><button class="btn btn-primary" data-add>添加账号</button></div>${accountTable()}</section><section class="panel"><div class="panel-head"><h2>最近签到</h2><button class="btn btn-ghost" data-view="history">查看全部</button></div>${historyTable(state.checkins.slice(0, 8))}</section></div>`
}
function accountsView() {
  return `<section class="panel"><div class="panel-head"><div><h2>我的账号</h2><p class="section-note">每个账号独立设置登录信息、签到时间与通知。</p></div><button class="btn btn-primary" data-add>添加账号</button></div>${accountTable()}</section>`
}
function cookieWarningSummary(item) {
  if (item.cookieWarningEnabled === false) return '到期预警已关闭'
  if (!item.enabled) return '到期预警已暂停'
  if (!item.cookieExpiresAt) return '到期预警：未设置过期时间'
  if (!item.webhookUrl) return '到期预警：未设置 Webhook'
  if (item.cookieWarningError) return `预警推送失败：${item.cookieWarningError}`
  if (item.cookieWarningStatus === 'pending') return '到期提醒推送中'
  if (item.cookieWarningSentAt) return `已提醒：${fmt(item.cookieWarningSentAt)}`
  return `到期前 ${item.cookieWarningDays ?? 3} 天预警`
}
function accountTable() {
  if (!state.accounts.length) return '<div class="empty"><strong>添加第一个 GLaDOS 账号</strong><p>准备浏览器登录信息，设置时间段后即可开始定时签到。</p></div>'
  return '<div class="account-grid">' + state.accounts.map((item) => {
    const running = state.jobs[item.id] || jobLabel(item.activeJob)
    const disabled = running ? 'disabled' : ''
    return `<article class="account-card"><header class="account-heading"><h3>${esc(item.label)}</h3><span class="account-plan" aria-label="Plan 类型">${esc(item.plan || '套餐待获取')}</span>${running ? '<span class="badge badge-running">' + esc(running) + '中</span>' : badge(item.lastStatus)}<p class="account-email">${esc(item.email || '未填写备注邮箱')}</p><span class="account-days ${item.daysLeft != null && item.daysLeft <= 1 ? 'is-expiring' : ''}" title="${item.profileUpdatedAt ? `最近获取：${esc(fmt(item.profileUpdatedAt))}` : '读取新版插件或检测登录后获取'}">${item.daysLeft == null ? '剩余时长待获取' : `剩余 ${esc(item.daysLeft)} 天`}</span></header>
      <div class="account-points"><div><span>当前积分</span><strong>${esc(fmtPoints(item.currentPoints))}</strong></div><small>${item.pointsUpdatedAt ? `最近获取：${fmt(item.pointsUpdatedAt)}` : '签到后获取积分'}</small></div>
      <dl class="account-facts"><div><dt>每日定时</dt><dd>${item.enabled ? esc(item.scheduleTime) + ' – ' + esc(item.scheduleEndTime || item.scheduleTime) : '已暂停'}<small>${esc(item.scheduleTimezone)}</small></dd></div><div><dt>Cookie 到期</dt><dd>${item.hasFullCookie ? (item.cookieExpiresAt ? fmt(item.cookieExpiresAt) : '未设置') : '需要重新导入'}<small>${esc(cookieWarningSummary(item))}</small></dd></div></dl>
      <p class="exchange-summary">自动兑换 · ${item.autoExchangeEnabled ? (item.enabled ? '已开启，剩余 1 天时签到后检查' : '随每日定时签到暂停') : '已关闭'}</p>
      <div class="account-result"><span>最近运行 · ${fmt(item.lastCheckedAt)}</span><p>${esc(item.lastMessage || '还没有运行记录，保存后可先检测登录状态。')}</p></div>
      <footer class="account-actions"><div><button class="btn btn-primary" data-checkin="${item.id}" ${disabled}>立即签到</button><button class="btn btn-ghost" data-login="${item.id}" ${disabled}>检测登录</button></div><div><button class="btn btn-ghost" data-edit="${item.id}" ${disabled}>编辑</button><button class="btn btn-quiet-danger" data-delete="${item.id}" ${disabled} aria-label="删除账号 ${esc(item.label)}">删除</button></div></footer></article>`
  }).join('') + '</div>'
}
function historyView() {
  return `<section class="panel"><div class="panel-head"><div><h2>签到历史</h2><p class="section-note">显示最近 100 条记录；成功、失败及站点返回消息都保留在这里。</p></div></div>${historyTable(state.checkins)}</section>`
}
function historyTable(rows) {
  if (!rows.length) return '<div class="empty">暂无运行记录。</div>'
  return `<div class="table-wrap"><table><thead><tr><th>时间</th><th>账号</th><th>结果</th><th>消息</th></tr></thead><tbody>${rows.map((item) => `<tr><td class="mono">${fmt(item.checked_at)}</td><td>${esc(item.label)}${item.email ? `<br/><span class="mono">${esc(item.email)}</span>` : ''}</td><td>${badge(item.status)}</td><td class="history-message">${esc(item.message || '—')}</td></tr>`).join('')}</tbody></table></div>`
}
function accountModal() {
  const item = state.editing || {}
  return `<div class="modal"><section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="account-title">
    <div class="modal-head"><div><h2 id="account-title">${item.id ? '编辑账号' : '添加账号'}</h2><p class="section-note">登录信息 → 签到计划 → 通知设置</p></div><button type="button" class="btn btn-ghost" data-close aria-label="关闭账号设置">关闭</button></div><div class="import-panel"><div><strong>从已登录的浏览器导入</strong><p class="section-note">先安装插件并授权当前后台，再读取 Cookie。</p></div>
      <div class="modal-tools"><a class="btn btn-download" href="/downloads/glados-cookie-helper-v1.9.0.zip" download="glados-cookie-helper-v1.9.0.zip" data-download-extension title="下载浏览器 Cookie 读取插件压缩包">下载插件</a>
      <button type="button" class="btn btn-import" data-import-browser-cookie title="从当前浏览器的 GLaDOS 登录状态读取 Cookie">读取浏览器 Cookie</button></div>
    </div>
    <form id="account-form" class="form-grid"><p id="form-feedback" class="form-feedback full" role="status" hidden></p><fieldset class="form-section full"><legend>01 · 登录信息</legend><div class="form-grid">
      <div class="field"><label>显示名称</label><input name="label" value="${esc(item.label)}" required /></div>
      <div class="field"><label>备注邮箱（可选）</label><input name="email" type="email" value="${esc(item.email)}" /></div>
      <p class="profile-preview full" data-profile-preview>套餐：${esc(item.plan || '待获取')} · ${item.daysLeft == null ? '剩余时长待获取' : `剩余 ${esc(item.daysLeft)} 天`}（读取插件或检测登录后更新）</p>
      <input type="hidden" name="checkinMethod" value="http" />
      <details class="manual-cookies full"><summary>手动填写 Cookie</summary><div class="form-grid"><div class="field full"><label>浏览器 Cookie</label><small>至少填写同一次登录的 gld:sess 和 gld:sess.sig；如果浏览器同时存在 koa:sess 和 koa:sess.sig，也可以一并填写。编辑旧账号时留空可保持已保存的 Cookie。</small></div>
      <div class="field"><label>gld:sess</label><input name="gldSess" type="password" autocomplete="off" placeholder="${item.id ? '留空表示保持不变' : '填写 gld:sess 的值'}" /></div>
      <div class="field"><label>gld:sess.sig</label><input name="gldSessSig" type="password" autocomplete="off" placeholder="${item.id ? '留空表示保持不变' : '填写 gld:sess.sig 的值'}" /></div>
      <div class="field"><label>koa:sess（可选）</label><input name="koaSess" type="password" autocomplete="off" placeholder="${item.id ? '留空表示保持不变' : '填写 koa:sess 的值'}" /></div>
      <div class="field"><label>koa:sess.sig（可选）</label><input name="koaSessSig" type="password" autocomplete="off" placeholder="${item.id ? '留空表示保持不变' : '填写 koa:sess.sig 的值'}" /></div>
      </div></details><div class="field full"><label>Cookie 过期时间（可选）</label><input name="cookieExpiresAt" type="datetime-local" value="${esc(toLocalInput(item.cookieExpiresAt))}" /></div>
      </div></fieldset><fieldset class="form-section full"><legend>02 · 定时签到</legend><div class="form-grid"><div class="field full"><label class="check-label"><input name="enabled" type="checkbox" ${item.enabled === false ? '' : 'checked'} />启用每日定时签到</label></div><div class="field"><label>开始时间</label><input name="scheduleTime" type="time" value="${esc(item.scheduleTime || '07:15')}" required /></div>
      <div class="field"><label>结束时间（可跨午夜）</label><input name="scheduleEndTime" type="time" value="${esc(item.scheduleEndTime || item.scheduleTime || '09:15')}" required /></div>
      <div class="field full"><small>每天在此时间段内随机选择一分钟进入队列；起止时间相同为固定时间。队列繁忙时实际签到会顺延。</small></div>
      <div class="field"><label>签到时区</label><select name="scheduleTimezone">
        <option value="Asia/Shanghai" ${(item.scheduleTimezone || 'Asia/Shanghai') === 'Asia/Shanghai' ? 'selected' : ''}>Asia/Shanghai</option>
        <option value="Asia/Hong_Kong" ${item.scheduleTimezone === 'Asia/Hong_Kong' ? 'selected' : ''}>Asia/Hong_Kong</option>
        <option value="UTC" ${item.scheduleTimezone === 'UTC' ? 'selected' : ''}>UTC</option>
      </select></div>
      <div class="field full"><label class="check-label"><input name="autoExchangeEnabled" type="checkbox" ${item.autoExchangeEnabled ? 'checked' : ''} />自动兑换积分续期</label><small>官网显示剩余 1 天时，在签到后选择积分足够且可用的最长档位，只兑换一次。暂停每日定时签到也会暂停自动兑换；兑换结果通过已设置的 Webhook 通知。</small></div>
      </div></fieldset><details class="notification-settings full" ${item.webhookUrl ? 'open' : ''}><summary>03 · 通知与到期提醒 <span>可选</span></summary><div class="form-grid"><div class="field full"><small>填写 Webhook 后可接收签到结果；到期提醒还需要设置 Cookie 过期时间。</small></div><div class="field full"><label>Webhook URL（可选）</label><div class="inline-field"><input name="webhookUrl" type="url" value="${esc(item.webhookUrl)}" placeholder="https://example.com/hooks/glados" /><button type="button" class="btn btn-ghost" data-test-webhook>测试</button></div></div>
      <div class="field full"><label>Webhook Secret（可选）</label><input name="webhookSecret" type="password" placeholder="请求头 x-glados-signature；留空表示保持不变" /></div>
      <div class="field"><label class="check-label"><input name="cookieWarningEnabled" type="checkbox" ${item.cookieWarningEnabled === false ? '' : 'checked'} />Cookie 到期预警</label></div>
      <div class="field"><label>提前天数</label><input name="cookieWarningDays" type="number" min="1" max="30" step="1" value="${esc(item.cookieWarningDays ?? 3)}" required /></div>
</div></details>
      <div class="actions full"><span class="save-hint">保存后可在账号卡片中检测登录</span><button type="button" class="btn btn-ghost" data-close>取消</button><button type="submit" class="btn btn-primary">保存账号</button></div>
    </form>
  </section></div>`
}
function formFeedback(message, error = false) {
  const node = document.querySelector('#form-feedback')
  if (!node) return toast(message)
  node.hidden = false
  node.classList.toggle('is-error', error)
  node.textContent = message
  node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}
function bindActions() {
  document.querySelector('[data-add]')?.addEventListener('click', () => { state.modal = true; state.editing = null; state.dirty = false; renderShell() })
  document.querySelector('[data-refresh]')?.addEventListener('click', async (event) => { event.currentTarget.disabled = true; try { await loadData(); renderShell(); toast('已刷新') } catch (error) { toast(error.message); document.querySelector('[data-refresh]').disabled = false } })
  document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', closeModal))
  document.querySelector('#account-form')?.addEventListener('input', () => { state.dirty = true })
  document.querySelector('#account-form')?.addEventListener('invalid', (event) => {
    const section = event.target.closest('details')
    if (section) section.open = true
  }, true)
  document.querySelectorAll('.field input, .field select').forEach((input) => { const label = input.closest('.field').querySelector('label'); if (label) { input.id = 'field-' + input.name; label.htmlFor = input.id } })
  document.querySelector('[data-download-extension]')?.addEventListener('click', () => {
    toast('插件压缩包已开始下载，解压后请在浏览器扩展管理页加载该文件夹')
  })
  document.querySelector('[data-import-browser-cookie]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget
    const form = button.closest('.modal-card').querySelector('#account-form')
    const originalText = button.textContent
    button.disabled = true
    button.textContent = '正在读取...'
    try {
      const data = await readBrowserCookie()
      if (!data.cookieHeader) throw new Error('读取插件版本过旧，请下载并更新到 1.9.0 后重试')
      if (data.cookieHeader) {
        let hidden = form.elements.cookieHeader
        if (!hidden) {
          hidden = document.createElement('input')
          hidden.type = 'hidden'
          hidden.name = 'cookieHeader'
          form.append(hidden)
        }
        hidden.value = data.cookieHeader
        for (const name of ['gldSess', 'gldSessSig', 'koaSess', 'koaSessSig']) form.elements[name].value = ''
        state.dirty = true
      }
      form.elements.label.value = data.username || data.email || form.elements.label.value
      if (data.email) form.elements.email.value = data.email
      if (data.cookieExpiresAt) form.elements.cookieExpiresAt.value = toLocalInput(data.cookieExpiresAt)
      if ('leftDays' in data || 'plan' in data) {
        let profileInput = form.elements.importedProfile
        if (!profileInput) {
          profileInput = document.createElement('input')
          profileInput.type = 'hidden'
          profileInput.name = 'importedProfile'
          form.append(profileInput)
        }
        profileInput.value = JSON.stringify({ leftDays: data.leftDays ?? null, plan: data.plan ?? null })
        form.querySelector('[data-profile-preview]').textContent = `套餐：${data.plan || '待获取'} · ${data.daysLeft == null ? '剩余时长待获取' : `剩余 ${data.daysLeft} 天`}（已从官网读取）`
      }
      const names = Array.isArray(data.cookieNames) ? data.cookieNames.join('、') : '完整 Cookie'
      formFeedback(`已读取 ${names}。点击“保存账号”完成导入。`)
    } catch (error) {
      formFeedback(error.message, true)
    } finally {
      button.disabled = false
      button.textContent = originalText
    }
  })
  document.querySelector('#account-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = event.currentTarget
    const submit = form.querySelector('[type="submit"]')
    if (submit.disabled) return
    submit.disabled = true
    submit.textContent = '正在保存…'
    const payload = Object.fromEntries(new FormData(form))
    payload.enabled = event.currentTarget.elements.enabled.checked
    payload.autoExchangeEnabled = form.elements.autoExchangeEnabled.checked
    if (payload.importedProfile) payload.profile = JSON.parse(payload.importedProfile)
    delete payload.importedProfile
    payload.cookieWarningEnabled = event.currentTarget.elements.cookieWarningEnabled.checked
    payload.cookieWarningDays = Number(payload.cookieWarningDays)
    try {
      const url = state.editing ? `/api/accounts/${state.editing.id}` : '/api/accounts'
      await api(url, { method: state.editing ? 'PUT' : 'POST', body: JSON.stringify(payload) })
      state.modal = false
      state.dirty = false
      try { await loadData() } catch {
        renderShell()
        toast('账号已保存，列表刷新失败，请点击“刷新数据”。')
        return
      }
      renderShell()
      toast('账号已保存')
    } catch (e) {
      formFeedback(e.message, true)
    } finally {
      submit.disabled = false
      submit.textContent = '保存账号'
    }
  })
  document.querySelector('[data-test-webhook]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget
    const form = button.closest('form')
    const payload = Object.fromEntries(new FormData(form))
    if (!payload.webhookUrl) return toast('请先填写 Webhook URL')
    button.disabled = true
    try {
      const response = await api('/api/webhooks/test', { method: 'POST', body: JSON.stringify(payload) })
      const result = await waitJob(response.job.id)
      toast(`Webhook 测试成功（HTTP ${result.status}）`)
    } catch (error) {
      toast(`Webhook 测试失败：${error.message}`)
    } finally {
      button.disabled = false
    }
  })
  document.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => { state.editing = state.accounts.find((x) => x.id === Number(b.dataset.edit)); state.modal = true; state.dirty = false; renderShell() }))
  document.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', async () => { if (!confirm('确定删除这个账号及其历史记录吗？')) return; await api(`/api/accounts/${b.dataset.delete}`, { method: 'DELETE' }); await loadData(); renderShell(); toast('已删除') }))
  document.querySelectorAll('[data-login]').forEach((b) => b.addEventListener('click', () => runJob(`/api/accounts/${b.dataset.login}/login`, Number(b.dataset.login), '检测')))
  document.querySelectorAll('[data-checkin]').forEach((b) => b.addEventListener('click', () => runJob(`/api/accounts/${b.dataset.checkin}/checkin`, Number(b.dataset.checkin), '签到')))
}
async function boot() {
  try {
    const me = await api('/api/auth/me')
    state.user = me.user
    await loadData()
    renderShell()
  } catch {
    renderLogin()
  }
}
boot()
let refreshing = false
setInterval(async () => {
  if (!state.user || state.modal || refreshing || document.hidden || document.activeElement?.closest('.content')) return
  refreshing = true
  try {
    await loadData()
    if (state.user && !state.modal) renderShell()
  } catch { /* transient polling failures should not interrupt editing or execution */ }
  finally { refreshing = false }
}, 5000)
