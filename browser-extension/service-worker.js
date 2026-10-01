const GLADOS_ORIGIN = 'https://glados-facility.com'
const REQUIRED_COOKIE_NAMES = ['koa:sess', 'koa:sess.sig', 'gld:sess', 'gld:sess.sig']
const CONSOLE_ORIGINS = new Set([
  'http://127.0.0.1:3000',
  'http://localhost:3000',
])

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

function backendOrigin(url) {
  try {
    const parsed = new URL(url)
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin !== GLADOS_ORIGIN
      ? parsed.origin : ''
  } catch {
    return ''
  }
}

async function senderAllowed(sender) {
  const origin = backendOrigin(sender.url || sender.tab?.url || '')
  if (!origin) return false
  if (CONSOLE_ORIGINS.has(origin)) return true
  return chrome.permissions.contains({ origins: [permissionPattern(origin)] })
}

// Permission events and popup requests can arrive together. Serialize registration
// so both paths can repair the bridge without racing to create the same script ID.
let consoleTaskQueue = Promise.resolve()
function queueConsoleTask(task) {
  const result = consoleTaskQueue.then(task)
  consoleTaskQueue = result.catch(() => {})
  return result
}

async function registerConsoleScript(origin) {
  if (!await senderAllowed({ url: origin })) return false
  if (CONSOLE_ORIGINS.has(origin)) return true
  const id = registeredScriptId(origin)
  const script = {
    id, matches: [permissionPattern(origin)], js: ['content-script.js'],
    runAt: 'document_start', persistAcrossSessions: true,
  }
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] })
  if (existing.length) await chrome.scripting.updateContentScripts([script])
  else await chrome.scripting.registerContentScripts([script])
  return true
}

async function connectConsoleTab(tabId) {
  const tab = await chrome.tabs.get(tabId)
  const origin = backendOrigin(tab.url)
  if (!origin || !await registerConsoleScript(origin)) throw new Error('当前后台域名尚未获得插件授权')
  const current = await chrome.tabs.get(tabId)
  if (backendOrigin(current.url) !== origin || !await senderAllowed(current)) {
    throw new Error('当前页面已变化，请返回签到管理后台后重试')
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content-script.js'] })
}

function originFromPattern(pattern) {
  if (!/^https?:\/\/[^/*]+\/\*$/.test(pattern)) return ''
  return backendOrigin(pattern.slice(0, -2))
}

async function syncConsoleScripts(connectTabs = false) {
  const permissions = await chrome.permissions.getAll()
  const existing = await chrome.scripting.getRegisteredContentScripts()
  const origins = new Set((permissions.origins || []).map(originFromPattern).filter(Boolean))
  // Keep specific backend registrations when Chrome grants a broader host pattern.
  for (const script of existing) {
    if (!script.id.startsWith('glados_console_')) continue
    for (const pattern of script.matches || []) {
      const origin = originFromPattern(pattern)
      if (origin && await senderAllowed({ url: origin })) origins.add(origin)
    }
  }
  const desiredIds = new Set()
  for (const origin of origins) {
    if (await registerConsoleScript(origin) && !CONSOLE_ORIGINS.has(origin)) {
      desiredIds.add(registeredScriptId(origin))
    }
  }
  const staleIds = existing.filter((script) => script.id.startsWith('glados_console_') && !desiredIds.has(script.id))
    .map((script) => script.id)
  if (staleIds.length) await chrome.scripting.unregisterContentScripts({ ids: staleIds })
  if (!connectTabs) return
  const tabs = await chrome.tabs.query({})
  for (const tab of tabs) {
    if (!Number.isInteger(tab.id) || !await senderAllowed(tab)) continue
    // A tab may close or navigate while permissions are being synchronized.
    await connectConsoleTab(tab.id).catch(() => {})
  }
}

function restoreConsoleConnections(connectTabs = true) {
  return queueConsoleTask(() => syncConsoleScripts(connectTabs)).catch((error) => {
    console.warn('GLaDOS 后台连接恢复失败:', error.message)
  })
}

function decodeSession(value) {
  try {
    const decoded = decodeURIComponent(value)
    const normalized = decoded.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return {}
  }
}

function userFromStatus(payload) {
  const data = payload?.data || payload || {}
  const user = data.user || {}
  const email = data.email || user.email || ''
  const username = data.username || data.name || user.username || user.name || email || ''
  return { username: String(username || ''), email: String(email || '') }
}

async function statusFromExtensionRequest() {
  try {
    const response = await fetch(`${GLADOS_ORIGIN}/api/user/status`, {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    })
    if (response.ok) return userFromStatus(await response.json())
  } catch {
    // Fall back to an already-open GLaDOS tab below.
  }
  return null
}

async function statusFromOpenTab() {
  const tabs = await chrome.tabs.query({ url: `${GLADOS_ORIGIN}/*` })
  for (const tab of tabs) {
    if (!tab.id) continue
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: async () => {
          const response = await fetch('/api/user/status', {
            credentials: 'include',
            cache: 'no-store',
            headers: { Accept: 'application/json' },
          })
          return response.ok ? response.json() : null
        },
      })
      if (result) return userFromStatus(result)
    } catch {
      // Try another matching tab.
    }
  }
  return null
}

async function readGladosSession() {
  const hostname = new URL(GLADOS_ORIGIN).hostname
  // Reading exact cookies by URL is reliable for host-only and HttpOnly cookies.
  // Keep a name-only fallback for Chrome profiles that return an incomplete result.
  const directCookies = await Promise.all(REQUIRED_COOKIE_NAMES.map((name) => (
    chrome.cookies.get({ url: GLADOS_ORIGIN, name })
  )))
  let resolvedCookies = directCookies
  if (directCookies.some((cookie) => !cookie)) {
    const allCookies = await chrome.cookies.getAll({ domain: hostname })
    resolvedCookies = REQUIRED_COOKIE_NAMES.map((name, index) => (
      directCookies[index]
      || allCookies.find((cookie) => cookie.name === name && cookie.path === '/')
      || allCookies.find((cookie) => cookie.name === name)
      || null
    ))
  }
  const [legacy, legacySig, modern, modernSig] = resolvedCookies
  const modernCookies = [modern, modernSig]
  if (modernCookies.some((cookie) => !cookie)) throw new Error('当前浏览器没有找到完整的 GLaDOS Cookie，请重新登录后重试')
  const legacyCookies = legacy && legacySig ? [legacy, legacySig] : []
  const importedCookies = [...legacyCookies, ...modernCookies]

  const sessionData = decodeSession(modern.value)
  const expirations = importedCookies.map((cookie) => cookie.expirationDate).filter(value => Number.isFinite(value) && value > 0)
  const expirySeconds = expirations.length ? Math.min(...expirations) : null
  const expiryMs = expirySeconds ? expirySeconds * 1000 : Number(sessionData._expire || 0)
  const status = await statusFromExtensionRequest() || await statusFromOpenTab() || {}
  const fallbackName = sessionData.userId ? `GLaDOS ${sessionData.userId}` : 'GLaDOS 账号'
  const cookieParts = [
    ...(legacyCookies.length ? [
      ['koa:sess', legacy],
      ['koa:sess.sig', legacySig],
    ] : []),
    ['gld:sess', modern],
    ['gld:sess.sig', modernSig],
  ].filter(([, cookie]) => cookie?.value)
    .map(([name, cookie]) => `${name}=${cookie.value}`)
  const cookieHeader = cookieParts.join('; ')

  return {
    cookieHeader,
    cookieNames: cookieParts.map((part) => part.slice(0, part.indexOf('='))),
    username: status.username || status.email || fallbackName,
    email: status.email || '',
    cookieExpiresAt: Number.isFinite(expiryMs) && expiryMs > 0 ? new Date(expiryMs).toISOString() : '',
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!['READ_GLADOS_SESSION', 'CONNECT_GLADOS_CONSOLE'].includes(message?.type)) return false
  Promise.resolve()
    .then(async () => {
      if (message.type === 'CONNECT_GLADOS_CONSOLE') {
        if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) {
          throw new Error('仅插件弹窗可以连接后台页面')
        }
        if (!Number.isInteger(message.tabId)) throw new Error('没有找到当前浏览器页面')
        await queueConsoleTask(() => connectConsoleTab(message.tabId))
        return { connected: true }
      }
      if (!await senderAllowed(sender)) throw new Error('当前后台域名尚未获得插件授权')
      return readGladosSession()
    })
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message || '读取 GLaDOS Cookie 失败' }))
  return true
})

chrome.permissions.onAdded.addListener((permissions) => {
  if (permissions.origins?.length) return restoreConsoleConnections()
})
chrome.permissions.onRemoved.addListener((permissions) => {
  if (permissions.origins?.length) return restoreConsoleConnections(false)
})
chrome.runtime.onInstalled.addListener(() => restoreConsoleConnections())
chrome.runtime.onStartup.addListener(() => restoreConsoleConnections())
