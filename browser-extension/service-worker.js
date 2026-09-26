const GLADOS_ORIGIN = 'https://glados-facility.com'
const REQUIRED_COOKIE_NAMES = ['koa:sess', 'koa:sess.sig', 'gld:sess', 'gld:sess.sig']
const CONSOLE_ORIGINS = new Set([
  'http://127.0.0.1:3000',
  'http://localhost:3000',
])

function consoleOrigin(sender) {
  try {
    return new URL(sender.url || sender.tab?.url || '').origin
  } catch {
    return ''
  }
}

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

async function senderAllowed(sender) {
  const origin = consoleOrigin(sender)
  if (!origin || origin === GLADOS_ORIGIN) return false
  if (CONSOLE_ORIGINS.has(origin)) return true
  return chrome.permissions.contains({ origins: [permissionPattern(origin)] })
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
  if (message?.type !== 'READ_GLADOS_SESSION') return false
  Promise.resolve()
    .then(async () => {
      if (!await senderAllowed(sender)) throw new Error('当前后台域名尚未获得插件授权')
      return readGladosSession()
    })
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message || '读取 GLaDOS Cookie 失败' }))
  return true
})

chrome.permissions.onRemoved.addListener((permissions) => {
  const ids = (permissions.origins || [])
    .filter((pattern) => pattern.endsWith('/*'))
    .map((pattern) => registeredScriptId(pattern.slice(0, -2)))
  if (ids.length) chrome.scripting.unregisterContentScripts({ ids }).catch(() => {})
})
