import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const workerSource = readFileSync(new URL('../browser-extension/service-worker.js', import.meta.url), 'utf8')
const popupSource = readFileSync(new URL('../browser-extension/popup.js', import.meta.url), 'utf8')
const bridgeSource = readFileSync(new URL('../browser-extension/content-script.js', import.meta.url), 'utf8')
const backend = 'https://console.example.test'
const pattern = `${backend}/*`
const extensionId = 'fixture-extension'
const popupUrl = `chrome-extension://${extensionId}/popup.html`

function eventChannel() {
  const listeners = []
  return {
    addListener(listener) { listeners.push(listener) },
    async emit(...args) { await Promise.all(listeners.map(listener => listener(...args))) },
    listeners,
  }
}

function workerHarness({ origins = [], tabUrl = `${backend}/accounts` } = {}) {
  const granted = new Set(origins)
  const scripts = new Map()
  const calls = { registered: [], updated: [], injected: [], unregistered: [], warnings: [] }
  const tabs = new Map([[7, { id: 7, url: tabUrl }]])
  const chrome = {
    runtime: {
      id: extensionId,
      getURL: path => `chrome-extension://${extensionId}/${path}`,
      onMessage: eventChannel(),
      onInstalled: eventChannel(),
      onStartup: eventChannel(),
    },
    permissions: {
      contains: async ({ origins: requested }) => requested.every(origin => granted.has(origin)),
      getAll: async () => ({ origins: [...granted] }),
      onAdded: eventChannel(),
      onRemoved: eventChannel(),
    },
    tabs: {
      get: async id => {
        if (!tabs.has(id)) throw new Error('Tab closed')
        return { ...tabs.get(id) }
      },
      query: async () => [...tabs.values()].map(tab => ({ ...tab })),
    },
    scripting: {
      getRegisteredContentScripts: async ({ ids } = {}) => [...scripts.values()].filter(script => !ids || ids.includes(script.id)),
      registerContentScripts: async entries => {
        for (const script of entries) {
          if (scripts.has(script.id)) throw new Error('Duplicate script ID')
          scripts.set(script.id, script)
          calls.registered.push(script)
        }
      },
      updateContentScripts: async entries => {
        for (const script of entries) {
          if (!scripts.has(script.id)) throw new Error('Missing script ID')
          scripts.set(script.id, script)
          calls.updated.push(script)
        }
      },
      unregisterContentScripts: async ({ ids }) => {
        for (const id of ids) {
          scripts.delete(id)
          calls.unregistered.push(id)
        }
      },
      executeScript: async options => {
        calls.injected.push(options)
        return []
      },
    },
  }
  vm.runInNewContext(workerSource, {
    chrome, URL, TextDecoder, Uint8Array, atob,
    console: { warn: (...args) => calls.warnings.push(args) },
  })
  function message(payload, sender = { id: extensionId, url: popupUrl }) {
    return new Promise((resolve, reject) => {
      const accepted = chrome.runtime.onMessage.listeners[0](payload, sender, resolve)
      if (!accepted) reject(new Error('Message was not handled'))
    })
  }
  return { chrome, granted, scripts, calls, tabs, message }
}

test('granting backend permission connects the page without any popup continuation', async () => {
  const harness = workerHarness()
  harness.granted.add(pattern)
  await harness.chrome.permissions.onAdded.emit({ origins: [pattern] })

  assert.equal(harness.scripts.size, 1)
  assert.equal(harness.calls.registered.length, 1)
  const [registration] = harness.scripts.values()
  assert.deepEqual([...registration.matches], [pattern])
  assert.equal(registration.persistAcrossSessions, true)
  assert.equal(registration.runAt, 'document_start')
  assert.deepEqual([...registration.js], ['content-script.js'])
  assert.equal(harness.calls.injected.length, 1)
  assert.equal(harness.calls.injected[0].target.tabId, 7)
})

for (const event of ['onInstalled', 'onStartup']) {
  test(`${event} restores a missing registration for an already-authorized backend`, async () => {
    const harness = workerHarness({ origins: [pattern, 'https://glados-facility.com/*'] })
    await harness.chrome.runtime[event].emit({ reason: 'update' })

    assert.equal(harness.scripts.size, 1)
    assert.equal(harness.calls.injected.length, 1)
    assert.equal(harness.calls.warnings.length, 0)
    assert.deepEqual([...harness.calls.registered[0].matches], [pattern])
  })
}

test('a permission event and popup connection request can run together without duplicate registrations', async () => {
  const harness = workerHarness({ origins: [pattern] })
  const [, result] = await Promise.all([
    harness.chrome.permissions.onAdded.emit({ origins: [pattern] }),
    harness.message({ type: 'CONNECT_GLADOS_CONSOLE', tabId: 7 }),
  ])

  assert.equal(result.ok, true)
  assert.equal(result.data.connected, true)
  assert.equal(harness.scripts.size, 1)
  assert.equal(harness.calls.registered.length, 1)
  assert.equal(harness.calls.warnings.length, 0)
})

test('revoking permission removes its registration and subsequent connection attempts do not recreate it', async () => {
  const harness = workerHarness({ origins: [pattern] })
  await harness.chrome.permissions.onAdded.emit({ origins: [pattern] })
  const initialInjectionCount = harness.calls.injected.length
  harness.granted.delete(pattern)
  await harness.chrome.permissions.onRemoved.emit({ origins: [pattern] })
  const result = await harness.message({ type: 'CONNECT_GLADOS_CONSOLE', tabId: 7 })

  assert.equal(result.ok, false)
  assert.match(result.error, /尚未获得插件授权/)
  assert.equal(harness.scripts.size, 0)
  assert.equal(harness.calls.registered.length, 1)
  assert.equal(harness.calls.injected.length, initialInjectionCount)
  assert.equal(harness.calls.unregistered.length, 1)
})

test('permission revoked while its registration is queued is checked again before registering', async () => {
  const harness = workerHarness({ origins: [pattern] })
  let releaseSnapshot
  let snapshotTaken
  const snapshotReady = new Promise(resolve => { snapshotTaken = resolve })
  harness.chrome.permissions.getAll = async () => {
    const snapshot = [...harness.granted]
    snapshotTaken()
    await new Promise(resolve => { releaseSnapshot = resolve })
    return { origins: snapshot }
  }
  const pendingGrant = harness.chrome.permissions.onAdded.emit({ origins: [pattern] })
  await snapshotReady
  harness.granted.delete(pattern)
  releaseSnapshot()
  await pendingGrant

  assert.equal(harness.scripts.size, 0)
  assert.equal(harness.calls.registered.length, 0)
  assert.equal(harness.calls.injected.length, 0)
})

test('connection control messages are accepted only from this extension popup', async () => {
  const harness = workerHarness({ origins: [pattern] })
  const senders = [
    { id: extensionId, url: `${backend}/accounts`, tab: { id: 7 } },
    { id: 'another-extension', url: popupUrl },
    { id: extensionId, url: `chrome-extension://${extensionId}/other.html` },
  ]
  for (const sender of senders) {
    const result = await harness.message({ type: 'CONNECT_GLADOS_CONSOLE', tabId: 7 }, sender)
    assert.equal(result.ok, false)
    assert.match(result.error, /仅插件弹窗/)
  }
  assert.equal(harness.calls.registered.length, 0)
  assert.equal(harness.calls.injected.length, 0)
})

test('the popup cannot inject an unauthorized backend or the GLaDOS page', async () => {
  for (const tabUrl of [`${backend}/accounts`, 'https://glados-facility.com/console/checkin']) {
    const harness = workerHarness({ tabUrl })
    const result = await harness.message({ type: 'CONNECT_GLADOS_CONSOLE', tabId: 7 })
    assert.equal(result.ok, false)
    assert.equal(harness.calls.registered.length, 0)
    assert.equal(harness.calls.injected.length, 0)
  }
})

test('navigation to an unauthorized site during connection does not receive the bridge', async () => {
  const harness = workerHarness({ origins: [pattern] })
  let lookups = 0
  harness.chrome.tabs.get = async () => ({
    id: 7,
    url: ++lookups === 1 ? `${backend}/accounts` : 'https://another.example.test/',
  })
  const result = await harness.message({ type: 'CONNECT_GLADOS_CONSOLE', tabId: 7 })
  assert.equal(result.ok, false)
  assert.match(result.error, /页面已变化/)
  assert.equal(harness.calls.injected.length, 0)
})

test('injecting the content bridge repeatedly creates one listener and one response per read request', async () => {
  const listeners = []
  const posted = []
  let reads = 0
  const window = {
    location: { origin: backend },
    addEventListener(type, listener) { if (type === 'message') listeners.push(listener) },
    removeEventListener(type, listener) {
      if (type === 'message') {
        const index = listeners.indexOf(listener)
        if (index !== -1) listeners.splice(index, 1)
      }
    },
    postMessage(data, origin) { posted.push({ data, origin }) },
  }
  const context = vm.createContext({
    window,
    chrome: { runtime: { sendMessage: async () => { reads += 1; return { ok: true, data: { username: 'Fixture account' } } } } },
  })
  vm.runInContext(bridgeSource, context)
  vm.runInContext(bridgeSource, context)
  assert.equal(listeners.length, 1)
  await listeners[0]({
    source: window,
    origin: backend,
    data: { source: 'glados-checkin-console', type: 'GLADOS_COOKIE_IMPORT_REQUEST', requestId: 'fixture-request' },
  })
  const responses = posted.filter(({ data }) => data.type === 'GLADOS_COOKIE_IMPORT_RESPONSE')
  assert.equal(reads, 1)
  assert.equal(responses.length, 1)
  assert.equal(responses[0].data.requestId, 'fixture-request')
  assert.equal(responses[0].data.ok, true)
  assert.equal(responses[0].origin, backend)
})

test('reconnecting replaces a listener from a previous extension runtime context', async () => {
  const listeners = new Set()
  const posted = []
  let oldReads = 0
  const window = {
    location: { origin: backend },
    addEventListener(type, listener) { if (type === 'message') listeners.add(listener) },
    removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener) },
    postMessage(data) { posted.push(data) },
  }
  vm.runInNewContext(bridgeSource, {
    window,
    chrome: { runtime: { sendMessage: async () => { oldReads += 1; throw new Error('Extension context invalidated') } } },
  })
  vm.runInNewContext(bridgeSource, {
    window,
    chrome: { runtime: { sendMessage: async () => ({ ok: true, data: { username: 'Fixture account' } }) } },
  })
  assert.equal(listeners.size, 1)
  await [...listeners][0]({
    source: window, origin: backend,
    data: { source: 'glados-checkin-console', type: 'GLADOS_COOKIE_IMPORT_REQUEST', requestId: 'reloaded-extension' },
  })
  assert.equal(oldReads, 0)
  const responses = posted.filter(data => data.type === 'GLADOS_COOKIE_IMPORT_RESPONSE')
  assert.equal(responses.length, 1)
  assert.equal(responses[0].ok, true)
})

function popupHarness({ authorized = true, response = { ok: true, data: { connected: true } } } = {}) {
  const nodes = new Map()
  const messages = []
  for (const selector of ['#site-origin', '#site-status', '#message', '#authorize', '#reconnect', '#revoke']) {
    const classes = new Set()
    nodes.set(selector, {
      textContent: '', disabled: false, handlers: {},
      classList: {
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name) },
        add(name) { classes.add(name) },
        remove(name) { classes.delete(name) },
        contains(name) { return classes.has(name) },
      },
      addEventListener(type, listener) { this.handlers[type] = listener },
    })
  }
  const chrome = {
    tabs: { query: async () => [{ id: 7, url: `${backend}/accounts` }] },
    permissions: {
      contains: async () => authorized,
      request: async () => { authorized = true; return true },
      remove: async () => { authorized = false; return true },
    },
    runtime: { sendMessage: async message => { messages.push(message); return response } },
  }
  vm.runInNewContext(popupSource, { chrome, URL, document: { querySelector: selector => nodes.get(selector) } })
  return { nodes, messages }
}

const settlePopup = () => new Promise(resolve => setImmediate(resolve))

test('opening the popup on an authorized backend automatically repairs its connection', async () => {
  const harness = popupHarness()
  await settlePopup()
  assert.equal(harness.messages.length, 1)
  assert.equal(harness.messages[0].type, 'CONNECT_GLADOS_CONSOLE')
  assert.equal(harness.messages[0].tabId, 7)
  assert.match(harness.nodes.get('#site-status').textContent, /已连接/)
  assert.match(harness.nodes.get('#message').textContent, /以后刷新会自动连接/)
})

test('an unauthorized popup does not attempt a connection before the user grants permission', async () => {
  const harness = popupHarness({ authorized: false })
  await settlePopup()
  assert.equal(harness.messages.length, 0)
  assert.equal(harness.nodes.get('#authorize').classList.contains('hidden'), false)
  await harness.nodes.get('#authorize').handlers.click()
  assert.equal(harness.messages.length, 1)
  assert.match(harness.nodes.get('#site-status').textContent, /已连接/)
})

test('a failed automatic connection is displayed as a failure instead of reporting success', async () => {
  const harness = popupHarness({ response: { ok: false, error: 'Fixture connection failure' } })
  await settlePopup()
  assert.equal(harness.nodes.get('#site-status').textContent, '已授权，连接失败')
  assert.equal(harness.nodes.get('#message').textContent, 'Fixture connection failure')
  assert.equal(harness.nodes.get('#message').classList.contains('error'), true)

  await harness.nodes.get('#reconnect').handlers.click()
  assert.equal(harness.nodes.get('#message').textContent, 'Fixture connection failure')
  assert.doesNotMatch(harness.nodes.get('#message').textContent, /连接成功/)
})

test('permission granted with a connection failure keeps the popup permission state accurate', async () => {
  const harness = popupHarness({ authorized: false, response: { ok: false, error: 'Fixture connection failure' } })
  await settlePopup()
  await harness.nodes.get('#authorize').handlers.click()
  assert.equal(harness.nodes.get('#site-status').textContent, '已授权，连接失败')
  assert.equal(harness.nodes.get('#authorize').classList.contains('hidden'), true)
  assert.equal(harness.nodes.get('#reconnect').classList.contains('hidden'), false)
  assert.equal(harness.nodes.get('#message').textContent, 'Fixture connection failure')
})
