import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { JobRegistry, SerialQueue } from '../src/jobs.js'
import { httpError, withRetry } from '../src/retry.js'
import { safeErrorMessage } from '../src/errors.js'

test('FIFO work is globally serialized and a failure releases the queue', async () => {
  const queue = new SerialQueue()
  let active = 0
  let peak = 0
  const order = []
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => queue.run(async () => {
    order.push(i)
    peak = Math.max(peak, ++active)
    await sleep(5)
    active -= 1
    if (i === 2) throw new Error('fixture failure')
    return i
  })))
  assert.equal(peak, 1)
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7])
  assert.equal(results[2].status, 'rejected')
  assert.equal(results[7].value, 7)
})

test('manual/scheduled duplicates share a job; login/check-in remain distinct', async () => {
  const registry = new JobRegistry()
  let checkins = 0
  const first = registry.enqueue({ type: 'checkin', accountId: 1 }, async () => { checkins += 1; return 'checked' })
  const duplicate = registry.enqueue({ type: 'checkin', accountId: 1, source: 'scheduled' }, () => assert.fail('duplicate'))
  const login = registry.enqueue({ type: 'login', accountId: 1 }, () => 'logged in')
  assert.equal(first.id, duplicate.id)
  assert.equal(login.status, 'queued')
  assert.notEqual(login.id, first.id)
  await Promise.all([registry.wait(first.id), registry.wait(login.id)])
  assert.equal(checkins, 1)
  assert.equal(registry.forAccount(1), null)
})

test('slow notifications do not hold the GLaDOS slot but keep duplicate suppression', async () => {
  const registry = new JobRegistry()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const first = registry.enqueue({ type: 'checkin', accountId: 1 }, () => 'first', async (value) => { await gate; return value })
  const second = registry.enqueue({ type: 'checkin', accountId: 2 }, () => 'second')
  assert.equal(await registry.wait(second.id), 'second')
  assert.equal(first.status, 'notifying')
  assert.equal(registry.enqueue({ type: 'checkin', accountId: 1 }, () => assert.fail('duplicate')).id, first.id)
  release()
  assert.equal(await registry.wait(first.id), 'first')
})

test('exceptions clear account state and allow the next attempt', async () => {
  const registry = new JobRegistry()
  const bad = registry.enqueue({ type: 'login', accountId: 99 }, () => { throw new Error('missing account') })
  await assert.rejects(registry.wait(bad.id), /missing account/)
  const good = registry.enqueue({ type: 'login', accountId: 99 }, () => true)
  assert.notEqual(bad.id, good.id)
  assert.equal(await registry.wait(good.id), true)
})

test('retry has bounded exponential backoff and honors Retry-After', async () => {
  const waits = []
  let calls = 0
  const result = await withRetry(() => {
    if (++calls < 3) throw httpError('fixture', 503, '2')
    return 'ok'
  }, { wait: async (ms) => waits.push(ms), delayMs: 100 })
  assert.equal(result, 'ok')
  assert.deepEqual(waits, [2000, 2000])
  calls = 0
  await assert.rejects(withRetry(() => {
    calls += 1
    throw httpError('fixture', 400)
  }), /400/)
  assert.equal(calls, 1)
})

test('logs strip request headers and URL query secrets', () => {
  const raw = 'apiRequestContext.get: Timeout 30000ms exceeded.\nCall log:\n- cookie: koa:sess=fixture-token'
  assert.equal(safeErrorMessage(new Error(raw)), 'apiRequestContext.get: Timeout 30000ms exceeded.')
  assert.doesNotMatch(safeErrorMessage(new Error('failed https://fixture.test/hook?key=private-token')), /private-token/)
})
