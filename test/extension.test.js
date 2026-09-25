import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../browser-extension/service-worker.js', import.meta.url), 'utf8')
function readSession(cookies) {
  const context = vm.createContext({
    URL, TextDecoder, Uint8Array, atob,
    fetch: async () => ({ ok: true, json: async () => ({ email: 'fixture@example.test' }) }),
    chrome: {
      cookies: { get: async ({ name }) => cookies[name] || null },
      runtime: { onMessage: { addListener() {} } },
      permissions: { onRemoved: { addListener() {} } },
    },
  })
  vm.runInContext(source, context)
  return vm.runInContext('readGladosSession()', context)
}
const cookie = (value, expirationDate) => ({ value, expirationDate })

test('extension prefers a complete gld pair over stale koa and uses earliest expiry', async () => {
  const result = await readSession({
    'gld:sess': cookie('new-session', 2000000000),
    'gld:sess.sig': cookie('new-signature', 1900000000),
    'koa:sess': cookie('old-session', 2100000000),
    'koa:sess.sig': cookie('old-signature', 2100000000),
  })
  assert.equal(result.cookieNamespace, 'gld')
  assert.equal(result.sess, 'new-session')
  assert.equal(result.sessSig, 'new-signature')
  assert.equal(result.cookieExpiresAt, new Date(1900000000000).toISOString())
})

test('extension never combines a partial gld session with legacy cookies', async () => {
  await assert.rejects(readSession({
    'gld:sess': cookie('new'), 'koa:sess': cookie('old'), 'koa:sess.sig': cookie('old-signature'),
  }), /重新登录/)
})

test('legacy-only session is explicitly marked koa', async () => {
  const result = await readSession({ 'koa:sess': cookie('old'), 'koa:sess.sig': cookie('sig') })
  assert.equal(result.cookieNamespace, 'koa')
})
