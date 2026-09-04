const GLADOS_ORIGIN = 'https://glados-facility.com'
const STATIC_CONSOLE_ORIGINS = new Set([
  'http://127.0.0.1:3000',
  'http://localhost:3000',
])

const originNode = document.querySelector('#site-origin')
const statusNode = document.querySelector('#site-status')
const messageNode = document.querySelector('#message')
const authorizeButton = document.querySelector('#authorize')
const reconnectButton = document.querySelector('#reconnect')
const revokeButton = document.querySelector('#revoke')

let currentSite = null

function permissionPattern(origin) {
  return `${origin}/*`
}

function registeredScriptId(origin) {
  let hash = 2166136261
  for (const char of origin) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return `glados_console_${(hash >>> 0).toString(16)}`
}

function setMessage(message, isError = false) {
  messageNode.textContent = message
  messageNode.classList.toggle('error', isError)
}

function setBusy(busy) {
  authorizeButton.disabled = busy
  reconnectButton.disabled = busy
  revokeButton.disabled = busy
}

async function activeSite() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id || !tab.url) throw new Error('没有找到当前浏览器页面')
  const url = new URL(tab.url)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('请先打开管理后台网页')
  if (url.origin === GLADOS_ORIGIN) throw new Error('当前是 GLaDOS 页面，请切换到签到管理后台')
  return { tabId: tab.id, origin: url.origin, pattern: permissionPattern(url.origin) }
}

async function registerContentScript(site) {
  const id = registeredScriptId(site.origin)
  const script = {
    id,
    matches: [site.pattern],
    js: ['content-script.js'],
    runAt: 'document_start',
    persistAcrossSessions: true,
  }
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] })
  if (existing.length) await chrome.scripting.updateContentScripts([script])
  else await chrome.scripting.registerContentScripts([script])
}

async function injectCurrentPage(site) {
  await chrome.scripting.executeScript({
    target: { tabId: site.tabId },
    files: ['content-script.js'],
  })
}

async function render() {
  try {
    currentSite = await activeSite()
    originNode.textContent = currentSite.origin
    const isStatic = STATIC_CONSOLE_ORIGINS.has(currentSite.origin)
    const isGranted = isStatic || await chrome.permissions.contains({ origins: [currentSite.pattern] })

    statusNode.textContent = isStatic ? '内置允许' : isGranted ? '已永久授权' : '尚未授权'
    statusNode.classList.toggle('granted', isGranted)
    authorizeButton.classList.toggle('hidden', isGranted)
    reconnectButton.classList.toggle('hidden', !isGranted)
    revokeButton.classList.toggle('hidden', isStatic || !isGranted)
    setMessage(isGranted ? '可以连接当前后台页面。' : '授权后会一直保留，直到你主动取消。')
  } catch (error) {
    currentSite = null
    originNode.textContent = '不可授权'
    statusNode.textContent = '不可用'
    statusNode.classList.remove('granted')
    authorizeButton.classList.add('hidden')
    reconnectButton.classList.add('hidden')
    revokeButton.classList.add('hidden')
    setMessage(error.message, true)
  }
}

authorizeButton.addEventListener('click', async () => {
  if (!currentSite) return
  setBusy(true)
  setMessage('正在请求浏览器授权...')
  try {
    const granted = await chrome.permissions.request({ origins: [currentSite.pattern] })
    if (!granted) throw new Error('你没有授予当前网站权限')
    await registerContentScript(currentSite)
    await injectCurrentPage(currentSite)
    await render()
    setMessage('授权成功，现在可以返回后台点击“一键读取浏览器 Cookie”。')
  } catch (error) {
    setMessage(error.message || '授权失败', true)
  } finally {
    setBusy(false)
  }
})

reconnectButton.addEventListener('click', async () => {
  if (!currentSite) return
  setBusy(true)
  try {
    if (!STATIC_CONSOLE_ORIGINS.has(currentSite.origin)) await registerContentScript(currentSite)
    await injectCurrentPage(currentSite)
    setMessage('连接成功，现在可以返回后台读取 Cookie。')
  } catch (error) {
    setMessage(error.message || '连接当前页面失败', true)
  } finally {
    setBusy(false)
  }
})

revokeButton.addEventListener('click', async () => {
  if (!currentSite) return
  setBusy(true)
  try {
    const id = registeredScriptId(currentSite.origin)
    await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {})
    await chrome.permissions.remove({ origins: [currentSite.pattern] })
    await render()
    setMessage('已取消当前网站授权，刷新后台页面后生效。')
  } catch (error) {
    setMessage(error.message || '取消授权失败', true)
  } finally {
    setBusy(false)
  }
})

render()
