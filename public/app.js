const app = document.querySelector('#app')
let state = { user: null, accounts: [], checkins: [], view: 'overview', modal: false, editing: null, jobs: {} }

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
  const response = await fetch(url, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || '请求失败')
  return data
}
function toast(message) {
  const node = document.createElement('div')
  node.className = 'toast'
  node.textContent = message
  document.body.append(node)
  setTimeout(() => node.remove(), 2800)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function readBrowserCookie() {
  return new Promise((resolve, reject) => {
    const requestId = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`
    const timeout = setTimeout(() => {
      window.removeEventListener('message', receive)
      reject(new Error('未检测到 GLaDOS Cookie Helper 扩展，请先安装扩展并刷新本页'))
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
  state.jobs[accountId] = label
  renderShell()
  try {
    const created = await api(url, { method: 'POST' })
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await sleep(1500)
      const { job } = await api(`/api/jobs/${created.job.id}`)
      if (job.status === 'completed') {
        delete state.jobs[accountId]
        await loadData()
        renderShell()
        toast(job.result?.message || `${label}完成`)
        return
      }
      if (job.status === 'failed') throw new Error(job.error || `${label}失败`)
    }
    throw new Error(`${label}等待超时，后台任务可能仍在执行`)
  } catch (error) {
    delete state.jobs[accountId]
    await loadData().catch(() => {})
    renderShell()
    toast(error.message)
  }
}
function renderLogin(error = '') {
  app.innerHTML = `<main class="login-screen"><section class="login-card"><div class="brand"><div class="brand-mark">G</div><span>GLaDOS Console</span></div><h1>自动签到控制台</h1><p>使用 Cookie 管理多账号签到与 Webhook 推送。</p>${error ? `<div class="notice">${esc(error)}</div>` : ''}<form id="login-form"><div class="field"><label>管理员账号</label><input name="username" autocomplete="username" required /></div><div class="field"><label>管理员密码</label><input name="password" type="password" autocomplete="current-password" required /></div><button class="btn btn-primary" style="width:100%">登录后台</button></form></section></main>`
  document.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) })
      await boot()
    } catch (e) {
      renderLogin(e.message)
    }
  })
}
async function loadData() {
  const [accounts, checkins] = await Promise.all([api('/api/accounts'), api('/api/checkins?limit=100')])
  state.accounts = accounts.accounts
  state.checkins = checkins.checkins
}
function renderShell() {
  const success = state.checkins.filter((item) => item.status === 'success' || item.status === 'already_signed').length
  const active = state.accounts.filter((item) => item.enabled).length
  app.innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><div class="brand-mark">G</div><span>GLaDOS Console</span></div><nav class="nav"><button data-view="overview" class="${state.view === 'overview' ? 'active' : ''}">总览</button><button data-view="accounts" class="${state.view === 'accounts' ? 'active' : ''}">Cookie 管理</button><button data-view="history" class="${state.view === 'history' ? 'active' : ''}">签到历史</button></nav><div class="sidebar-foot">每个账号可独立设置<br/>每日签到时间与时区</div></aside><main class="main"><header class="topbar"><h1>${state.view === 'overview' ? '今天的运行状态' : state.view === 'accounts' ? 'Cookie 管理' : '签到历史'}</h1><button id="logout" class="btn btn-ghost">退出登录</button></header><section class="content">${state.view === 'overview' ? overview(success, active) : state.view === 'accounts' ? accountsView() : historyView()}</section></main></div>${state.modal ? accountModal() : ''}`
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => { state.view = button.dataset.view; renderShell() }))
  document.querySelector('#logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); state.user = null; renderLogin() })
  bindActions()
}
function overview(success, active) {
  return `<div class="grid stats"><article class="stat"><div class="label">Cookie 账号</div><div class="value">${state.accounts.length}</div></article><article class="stat"><div class="label">启用账号</div><div class="value">${active}</div></article><article class="stat"><div class="label">成功 / 已签到</div><div class="value">${success}</div></article><article class="stat"><div class="label">最近一次运行</div><div class="value" style="font-size:16px">${fmt(state.checkins[0]?.checked_at)}</div></article></div><div class="grid" style="margin-top:18px"><section class="panel"><div class="panel-head"><h2>Cookie 状态</h2><button class="btn btn-primary" data-add>添加 Cookie</button></div>${accountTable()}</section><section class="panel"><div class="panel-head"><h2>最近签到</h2><button class="btn btn-ghost" data-view="history">查看全部</button></div>${historyTable(state.checkins.slice(0, 8))}</section></div>`
}
function accountsView() {
  return `<section class="panel"><div class="panel-head"><h2>多账号 Cookie 与独立 Webhook</h2><button class="btn btn-primary" data-add>添加 Cookie</button></div>${accountTable()}</section>`
}
function accountTable() {
  if (!state.accounts.length) return '<div class="empty">还没有 Cookie 账号，先添加一个 GLaDOS Cookie 吧。</div>'
  return `<div class="table-wrap"><table><thead><tr><th>账号</th><th>Cookie</th><th>定时</th><th>状态</th><th>最近运行</th><th>操作</th></tr></thead><tbody>${state.accounts.map((item) => {
    const running = state.jobs[item.id]
    return `<tr><td><strong>${esc(item.label)}</strong>${item.email ? `<br/><span class="mono">${esc(item.email)}</span>` : ''}</td><td>${item.hasCookieSess && item.hasCookieSessSig ? '<span class="badge badge-success">双 Cookie 已保存</span>' : item.hasCookie ? '<span class="badge badge-warn">旧格式</span>' : '<span class="badge badge-muted">未保存</span>'}<br/><small>${item.cookieExpiresAt ? `过期：${fmt(item.cookieExpiresAt)}` : '未设置过期时间'}</small></td><td>${item.enabled ? `<strong>${esc(item.scheduleTime)}</strong><br/><span class="mono">${esc(item.scheduleTimezone)}</span>` : '<span class="badge badge-muted">已关闭</span>'}</td><td>${running ? '<span class="badge badge-running">' + esc(running) + '中</span>' : badge(item.lastStatus)}<br/><small>${esc(item.lastMessage || '')}</small></td><td>${fmt(item.lastCheckedAt)}</td><td><button class="btn btn-ghost" data-login="${item.id}" ${running ? 'disabled' : ''}>检测</button> <button class="btn btn-primary" data-checkin="${item.id}" ${running ? 'disabled' : ''}>签到</button> <button class="btn btn-ghost" data-edit="${item.id}" ${running ? 'disabled' : ''}>编辑</button> <button class="btn btn-danger" data-delete="${item.id}" ${running ? 'disabled' : ''}>删除</button></td></tr>`
  }).join('')}</tbody></table></div>`
}
function historyView() {
  return `<section class="panel"><div class="panel-head"><h2>签到历史</h2><button class="btn btn-ghost" data-refresh>刷新</button></div>${historyTable(state.checkins)}</section>`
}
function historyTable(rows) {
  if (!rows.length) return '<div class="empty">暂无运行记录。</div>'
  return `<div class="table-wrap"><table><thead><tr><th>时间</th><th>账号</th><th>结果</th><th>当前积分</th><th>消息</th></tr></thead><tbody>${rows.map((item) => `<tr><td class="mono">${fmt(item.checked_at)}</td><td>${esc(item.label)}${item.email ? `<br/><span class="mono">${esc(item.email)}</span>` : ''}</td><td>${badge(item.status)}</td><td>${esc(fmtPoints(item.points))}</td><td>${esc(item.message || '—')}</td></tr>`).join('')}</tbody></table></div>`
}
function accountModal() {
  const item = state.editing || {}
  return `<div class="modal"><section class="modal-card"><div class="modal-head"><h2>${item.id ? '编辑 Cookie' : '添加 Cookie'}</h2><div class="modal-tools"><a class="btn btn-download" href="/downloads/glados-cookie-helper-v1.0.1.zip" download="glados-cookie-helper-v1.0.1.zip" data-download-extension title="下载浏览器 Cookie 读取插件压缩包">下载读取 Cookie 插件</a><button type="button" class="btn btn-import" data-import-browser-cookie title="从当前浏览器的 GLaDOS 登录状态读取 Cookie">一键读取浏览器 Cookie</button></div></div><form id="account-form" class="form-grid"><div class="field"><label>显示名称</label><input name="label" value="${esc(item.label)}" required /></div><div class="field"><label>备注邮箱（可选）</label><input name="email" type="email" value="${esc(item.email)}" /></div><div class="field"><label>koa:sess</label><input name="sess" autocomplete="off" placeholder="${item.id ? '留空表示保持不变' : '填写 koa:sess 的值'}" ${item.id ? '' : 'required'} /></div><div class="field"><label>koa:sess.sig</label><input name="sessSig" autocomplete="off" placeholder="${item.id ? '留空表示保持不变' : '填写 koa:sess.sig 的值'}" ${item.id ? '' : 'required'} /></div><div class="field full"><label>Cookie 过期时间（可选）</label><input name="cookieExpiresAt" type="datetime-local" value="${esc(toLocalInput(item.cookieExpiresAt))}" /></div><div class="field"><label>每日签到时间</label><input name="scheduleTime" type="time" value="${esc(item.scheduleTime || '07:15')}" required /></div><div class="field"><label>签到时区</label><select name="scheduleTimezone"><option value="Asia/Shanghai" ${(item.scheduleTimezone || 'Asia/Shanghai') === 'Asia/Shanghai' ? 'selected' : ''}>Asia/Shanghai</option><option value="Asia/Hong_Kong" ${item.scheduleTimezone === 'Asia/Hong_Kong' ? 'selected' : ''}>Asia/Hong_Kong</option><option value="UTC" ${item.scheduleTimezone === 'UTC' ? 'selected' : ''}>UTC</option></select></div><div class="field full"><label>Webhook URL（可选）</label><div class="inline-field"><input name="webhookUrl" type="url" value="${esc(item.webhookUrl)}" placeholder="https://example.com/hooks/glados" /><button type="button" class="btn btn-ghost" data-test-webhook>测试</button></div></div><div class="field full"><label>Webhook Secret（可选）</label><input name="webhookSecret" type="password" placeholder="请求头 x-glados-signature；留空表示保持不变" /></div><div class="field full"><label class="check-label"><input name="enabled" type="checkbox" ${item.enabled === false ? '' : 'checked'} />启用此账号的每日定时签到</label></div><div class="actions full"><button type="button" class="btn btn-ghost" data-close>取消</button><button class="btn btn-primary">保存</button></div></form></section></div>`
}
function bindActions() {
  document.querySelector('[data-add]')?.addEventListener('click', () => { state.modal = true; state.editing = null; renderShell() })
  document.querySelector('[data-refresh]')?.addEventListener('click', async () => { await loadData(); renderShell(); toast('已刷新') })
  document.querySelector('[data-close]')?.addEventListener('click', () => { state.modal = false; renderShell() })
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
      form.elements.sess.value = data.sess || ''
      form.elements.sessSig.value = data.sessSig || ''
      form.elements.label.value = data.username || data.email || form.elements.label.value
      if (data.email) form.elements.email.value = data.email
      if (data.cookieExpiresAt) form.elements.cookieExpiresAt.value = toLocalInput(data.cookieExpiresAt)
      toast('已读取 GLaDOS 登录信息，请确认后保存')
    } catch (error) {
      toast(error.message)
    } finally {
      button.disabled = false
      button.textContent = originalText
    }
  })
  document.querySelector('#account-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const payload = Object.fromEntries(new FormData(event.currentTarget))
    payload.enabled = event.currentTarget.elements.enabled.checked
    try {
      const url = state.editing ? `/api/accounts/${state.editing.id}` : '/api/accounts'
      await api(url, { method: state.editing ? 'PUT' : 'POST', body: JSON.stringify(payload) })
      state.modal = false
      await loadData()
      renderShell()
      toast('账号已保存')
    } catch (e) {
      toast(e.message)
    }
  })
  document.querySelector('[data-test-webhook]')?.addEventListener('click', async (event) => {
    const form = event.currentTarget.closest('form')
    const payload = Object.fromEntries(new FormData(form))
    if (!payload.webhookUrl) return toast('请先填写 Webhook URL')
    event.currentTarget.disabled = true
    try {
      const response = await api('/api/webhooks/test', { method: 'POST', body: JSON.stringify(payload) })
      toast(`Webhook 测试成功（HTTP ${response.result.status}）`)
    } catch (error) {
      toast(`Webhook 测试失败：${error.message}`)
    } finally {
      event.currentTarget.disabled = false
    }
  })
  document.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => { state.editing = state.accounts.find((x) => x.id === Number(b.dataset.edit)); state.modal = true; renderShell() }))
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
