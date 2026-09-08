import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import { once } from 'node:events'

process.env.WEBHOOK_TIMEOUT_MS = '150'
process.env.WEBHOOK_ATTEMPTS = '3'
process.env.RETRY_DELAY_MS = '0'
const { deliverWebhook } = await import('../src/webhook.js')
let mode
let deliveries = []
const server = http.createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  deliveries.push({ headers: req.headers, body })
  if (mode === 'retry' && deliveries.length < 3) return res.writeHead(503).end()
  if (mode === 'bad') return res.writeHead(400).end()
  if (mode === 'stall' && deliveries.length < 3) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"pending":')
    return
  }
  res.end('ok')
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const url = `http://127.0.0.1:${server.address().port}/hook`
after(() => { server.closeAllConnections(); server.close() })

test('retry preserves payload, delivery ID and HMAC signature', async () => {
  mode = 'retry'
  deliveries = []
  const result = await deliverWebhook({ url, secret: 'fixture-secret', result: { status: 'success' } })
  assert.equal(result.attempts, 3)
  assert.equal(deliveries.length, 3)
  assert.ok(deliveries.every((entry) => entry.body === deliveries[0].body))
  assert.ok(deliveries.every((entry) => entry.headers['idempotency-key'] === result.deliveryId))
  const signature = crypto.createHmac('sha256', 'fixture-secret').update(deliveries[0].body).digest('hex')
  assert.equal(deliveries[0].headers['x-glados-signature'], signature)
})

test('permanent HTTP errors are not retried', async () => {
  mode = 'bad'
  deliveries = []
  await assert.rejects(deliverWebhook({ url, result: { status: 'success' } }), /HTTP 400/)
  assert.equal(deliveries.length, 1)
})

test('stalled response body is retried, not silently treated as success', async () => {
  mode = 'stall'
  deliveries = []
  const result = await deliverWebhook({ url, result: { status: 'success' } })
  assert.equal(result.attempts, 3)
  assert.equal(deliveries.length, 3)
})
