import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../browser-extension/service-worker.js', import.meta.url), 'utf8')
function readSession(cookies, { directRead = true } = {}) {
  const materializedCookies = Object.entries(cookies).map(([name, value]) => ({
    name, domain: 'glados-facility.com', path: '/', ...value,
  }))
  const context = vm.createContext({
    URL, TextDecoder, Uint8Array, atob,
    fetch: async () => ({ ok: true, json: async () => ({ email: 'fixture@example.test' }) }),
    chrome: {
      cookies: {
        get: async ({ name }) => directRead ? materializedCookies.find((cookie) => cookie.name === name) || null : null,
        getAll: async () => materializedCookies,
      },
      runtime: { onMessage: { addListener() {} } },
      permissions: { onRemoved: { addListener() {} } },
    },
  })
  vm.runInContext(source, context)
  return vm.runInContext('readGladosSession()', context)
}
const cookie = (value, expirationDate) => ({ value, expirationDate })

test('extension imports all four current browser cookies and uses earliest expiry', async () => {
  const result = await readSession({
    'gld:sess': cookie('new-session', 2000000000),
    'gld:sess.sig': cookie('new-signature', 1900000000),
    'koa:sess': cookie('old-session', 2100000000),
    'koa:sess.sig': cookie('old-signature', 2100000000),
  })
  assert.equal(result.cookieHeader, 'koa:sess=old-session; koa:sess.sig=old-signature; gld:sess=new-session; gld:sess.sig=new-signature')
  assert.deepEqual([...result.cookieNames], ['koa:sess', 'koa:sess.sig', 'gld:sess', 'gld:sess.sig'])
  assert.equal(result.cookieExpiresAt, new Date(1900000000000).toISOString())
})

test('extension falls back to a name lookup when direct Chrome cookie reads are incomplete', async () => {
  const result = await readSession({
    'gld:sess': cookie('new-session', 2000000000),
    'gld:sess.sig': cookie('new-signature', 1900000000),
    'koa:sess': cookie('old-session', 2100000000),
    'koa:sess.sig': cookie('old-signature', 2100000000),
  }, { directRead: false })
  assert.equal(result.cookieHeader, 'koa:sess=old-session; koa:sess.sig=old-signature; gld:sess=new-session; gld:sess.sig=new-signature')
})

test('extension rejects any incomplete four-cookie session', async () => {
  await assert.rejects(readSession({
    'gld:sess': cookie('new'), 'koa:sess': cookie('old'), 'koa:sess.sig': cookie('old-signature'),
  }), /四项/)
})

test('extension rejects the legacy-only pair', async () => {
  await assert.rejects(readSession({ 'koa:sess': cookie('old'), 'koa:sess.sig': cookie('sig') }), /四项/)
})
