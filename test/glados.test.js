import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'

let mode = 'normal'
let counts = {}
let receivedCookies = []
let receivedBody = ''
const server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    receivedBody = ''
    req.on('data', chunk => { receivedBody += chunk })
  }
  const route = req.url.split('/').at(-1)
  counts[route] = (counts[route] || 0) + 1
  receivedCookies.push(req.headers.cookie || '')
  if (route === 'status' && mode === 'status-retry' && counts[route] < 3) {
    res.writeHead(503).end()
  } else if (route === 'status' && mode === 'status-timeout' && counts[route] < 3) {
    // Leave the request open to exercise Playwright's actual deadline.
    return
  } else if (route === 'status' && mode === 'unauthorized') {
    res.writeHead(401).end()
  } else if (route === 'status' && mode === 'forbidden') {
    res.writeHead(403).end()
  } else if (route === 'status' && mode === 'business-unauthorized') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ code: -2, message: 'not logged in' }))
  } else if (route === 'status' && mode === 'html') {
    res.end('<html>challenge</html>')
  } else if (route === 'points' && mode === 'points-down') {
    res.writeHead(503).end()
  } else if (route === 'checkin' && mode === 'uncertain-post') {
    req.socket.destroy()
  } else if (route === 'checkin' && mode === 'missing-api') {
    res.writeHead(404).end()
  } else {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(
      route === 'status' ? { code: 0, data: { email: 'fixture@example.test', leftDays: '23.5' } }
        : route === 'points' ? { points: '8.0000000000000000', history: [{ change: '6.00000000' }] }
          : mode === 'modern' ? { code: 0, points: 6, message: 'Checkin! Got 6 Points', streak: 16, list: [{ change: '6.00000000', balance: '196.0000000000000000' }] }
          : mode === 'automated' ? { code: 4, message: 'Automated check-in detected. Please sign in again to continue. &#x20;' }
          : mode === 'observation-logged' ? { code: 1, points: 0, message: "Today's observation logged. Return tomorrow for more points." }
          : mode === 'already' ? { code: 1, message: 'Repeat! Already checked in' }
            : mode === 'business-failure' ? { code: 1, message: 'Checkin failed today' }
              : { code: 0, message: 'Checkin! Got 8 points' },
    ))
  }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
process.env.GLADOS_ORIGIN = `http://127.0.0.1:${server.address().port}`
process.env.GLADOS_REQUEST_TIMEOUT_MS = '500'
process.env.GLADOS_REQUEST_ATTEMPTS = '3'
process.env.RETRY_DELAY_MS = '0'
process.env.APP_SECRET = 'fixture-only'
const { GladosClient } = await import('../src/glados.js')
const { encrypt } = await import('../src/crypto.js')
const account = { cookie_sess_enc: encrypt('fixture-session'), cookie_sess_sig_enc: encrypt('fixture-signature') }
after(() => { server.closeAllConnections(); server.close() })

async function useClient(selectedMode, operation) {
  mode = selectedMode
  counts = {}
  receivedCookies = []
  const client = new GladosClient(account)
  try {
    await client.open()
    return await operation(client)
  } finally { await client.close() }
}

test('normal check-in uses isolated cookies, no browser, and normalized points', () => useClient('normal', async (client) => {
  const result = await client.checkin()
  assert.equal(result.status, 'success')
  assert.equal(result.points, '8')
  assert.equal(result.pointsChange, '6')
  assert.equal(client.browser, null)
  assert.deepEqual(counts, { status: 1, checkin: 1, points: 1 })
  assert.ok(receivedCookies.every((cookie) => cookie.includes('koa:sess=fixture-session') && cookie.includes('koa:sess.sig=fixture-signature')))
}))

test('current API sends origin hostname token and reads returned ledger without extra requests', () => useClient('modern', async (client) => {
  const result = await client.checkin()
  assert.equal(JSON.parse(receivedBody).token, '127.0.0.1')
  assert.equal(result.status, 'success')
  assert.equal(result.points, '196')
  assert.equal(result.pointsChange, '6')
  assert.deepEqual(counts, { status: 1, checkin: 1 })
}))

test('missing API fails without launching a browser or replaying POST', () => useClient('missing-api', async (client) => {
  await assert.rejects(client.checkin(), /404/)
  assert.equal(counts.checkin, 1)
  assert.equal(client.browser, null)
}))

test('transient status failures retry without repeating check-in', () => useClient('status-retry', async (client) => {
  assert.equal((await client.checkin()).status, 'success')
  assert.equal(counts.status, 3)
  assert.equal(counts.checkin, 1)
}))

test('actual status timeouts retry with a fresh request deadline', () => useClient('status-timeout', async (client) => {
  assert.equal((await client.checkin()).status, 'success')
  assert.equal(counts.status, 3)
  assert.equal(counts.checkin, 1)
}))

test('optional points failure preserves successful check-in', () => useClient('points-down', async (client) => {
  const result = await client.checkin()
  assert.equal(result.status, 'success')
  assert.equal(result.points, null)
  assert.match(result.message, /积分查询暂时失败/)
  assert.equal(counts.points, 3)
  assert.equal(counts.checkin, 1)
}))

test('uncertain POST is not retried or followed by a browser click', () => useClient('uncertain-post', async (client) => {
  const result = await client.checkin()
  assert.equal(result.outcomeUnknown, true)
  assert.match(result.message, /未自动重复提交/)
  assert.equal(counts.checkin, 1)
  assert.equal(client.browser, null)
}))

test('401 never submits a check-in', () => useClient('unauthorized', async (client) => {
  assert.equal((await client.checkin()).status, 'login_required')
  assert.equal(counts.checkin, undefined)
}))

test('403 is not mistaken for an authenticated session', () => useClient('forbidden', async (client) => {
  await assert.rejects(client.status(), /HTTP 403/)
  assert.equal(counts.status, 1)
}))

test('HTML challenge is reported explicitly', () => useClient('html', async (client) => {
  await assert.rejects(client.status(), /JSON/)
}))

test('already-signed results do not trigger fallback', () => useClient('already', async (client) => {
  assert.equal((await client.checkin()).status, 'already_signed')
  assert.equal(counts.checkin, 1)
  assert.equal(client.browser, null)
}))

test('failure messages containing checkin/today are not treated as success', () => useClient('business-failure', async (client) => {
  assert.equal((await client.checkin()).status, 'failed')
  assert.equal(counts.points, undefined)
}))

test('API cookie stores are independent between accounts', () => useClient('normal', async (first) => {
  const second = new GladosClient({ cookie_sess_enc: encrypt('other'), cookie_sess_sig_enc: encrypt('other-sig') })
  await second.open()
  try {
    const firstCookies = (await first.api.storageState()).cookies
    const secondCookies = (await second.api.storageState()).cookies
    assert.equal(firstCookies.find((cookie) => cookie.name === 'koa:sess').value, 'fixture-session')
    assert.equal(secondCookies.find((cookie) => cookie.name === 'koa:sess').value, 'other')
  } finally { await second.close() }
}))

test('partial browser startup is cleaned up even if no context exists', async () => {
  const client = new GladosClient(account)
  let closed = false
  client.browser = { close: async () => { closed = true } }
  await client.close()
  assert.equal(closed, true)
})

test('legacy Cookie headers still work without launching a browser', async () => {
  mode = 'normal'
  receivedCookies = []
  const client = new GladosClient({ cookie_enc: encrypt('Cookie: koa:sess=legacy; koa:sess.sig=legacy-sig; Path=/; HttpOnly') })
  try {
    await client.open()
    assert.equal((await client.status()).loggedIn, true)
    assert.match(receivedCookies[0], /koa:sess=legacy/)
    assert.doesNotMatch(receivedCookies[0], /Path|HttpOnly/)
  } finally { await client.close() }
})

test('expired cookies skip requests entirely', async () => {
  counts = {}
  const client = new GladosClient({ ...account, cookie_expires_at: '2000-01-01T00:00:00Z' })
  assert.equal((await client.checkin()).status, 'login_required')
  assert.deepEqual(counts, {})
})

test('gld cookie namespace is sent unchanged and never relabeled as koa', async () => {
  mode = 'modern'
  counts = {}
  receivedCookies = []
  const client = new GladosClient({ ...account, cookie_namespace: 'gld' })
  try {
    await client.open()
    assert.equal((await client.checkin()).status, 'success')
    assert.ok(receivedCookies.every(value => value.includes('gld:sess=fixture-session') && value.includes('gld:sess.sig=fixture-signature') && !value.includes('koa:')))
  } finally { await client.close() }
})

test('complete browser cookie header sends koa and gld session cookies together', async () => {
  mode = 'modern'
  counts = {}
  receivedCookies = []
  const cookieHeader = 'koa:sess=old-session; koa:sess.sig=old-signature; gld:sess=modern-session; gld:sess.sig=modern-signature'
  const client = new GladosClient({ ...account, cookie_namespace: 'gld', cookie_enc: encrypt(cookieHeader) })
  try {
    await client.open()
    assert.equal((await client.checkin()).status, 'success')
    assert.ok(receivedCookies.every(value => (
      value.includes('koa:sess=old-session')
      && value.includes('koa:sess.sig=old-signature')
      && value.includes('gld:sess=modern-session')
      && value.includes('gld:sess.sig=modern-signature')
    )))
  } finally { await client.close() }
})

test('HTTP 200 with business code -2 explains session migration and skips POST', () => useClient('business-unauthorized', async (client) => {
  const result = await client.checkin()
  assert.equal(result.status, 'login_required')
  assert.match(result.message, /gld:sess/)
  assert.equal(counts.checkin, undefined)
}))

test('automated check-in rejection is distinct from expired authentication and never replayed', () => useClient('automated', async (client) => {
  const result = await client.checkin()
  assert.equal(result.status, 'login_required')
  assert.equal(result.reason, 'automated_checkin_detected')
  assert.match(result.message, /官网重新登录/)
  assert.doesNotMatch(result.message, /&#x20;/)
  assert.deepEqual(counts, { status: 1, checkin: 1 })
  assert.equal(client.browser, null)
}))

test('current observation-logged response means already signed, not a new reward', () => useClient('observation-logged', async (client) => {
  const result = await client.checkin()
  assert.equal(result.status, 'already_signed')
  assert.equal(result.pointsChange, null)
  assert.equal(counts.checkin, 1)
}))
