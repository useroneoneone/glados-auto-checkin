const PAGE_SOURCE = 'glados-checkin-console'
const EXTENSION_SOURCE = 'glados-cookie-helper'

if (!window.__gladosCookieHelperBridgeInstalled) {
  window.__gladosCookieHelperBridgeInstalled = true

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return
    const message = event.data
    if (!message || message.source !== PAGE_SOURCE || message.type !== 'GLADOS_COOKIE_IMPORT_REQUEST' || !message.requestId) return

    try {
      const response = await chrome.runtime.sendMessage({ type: 'READ_GLADOS_SESSION' })
      window.postMessage({
        source: EXTENSION_SOURCE,
        type: 'GLADOS_COOKIE_IMPORT_RESPONSE',
        requestId: message.requestId,
        ...response,
      }, window.location.origin)
    } catch (error) {
      window.postMessage({
        source: EXTENSION_SOURCE,
        type: 'GLADOS_COOKIE_IMPORT_RESPONSE',
        requestId: message.requestId,
        ok: false,
        error: error.message || '浏览器扩展读取失败',
      }, window.location.origin)
    }
  })

  window.postMessage({ source: EXTENSION_SOURCE, type: 'GLADOS_COOKIE_HELPER_READY' }, window.location.origin)
}
