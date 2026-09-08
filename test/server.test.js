import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

test('authenticated HTTP jobs deduplicate and webhook tests return 202', { timeout: 20000 }, async () => {
  let active = 0
  let peak = 0
  let posts = 0
  const fixture = http.createServer(async (req, res) => {
    if (req.url === '/hook') {
      await sleep(300)
      res.end('ok')
      return
    }
    peak = Math.max(peak, ++active)
    await sleep(80)
    active -= 1
    if (req.method === 'POST') posts += 1
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url.endsWith('status')
      ? { data: { email: 'fixture@example.test' } }
      : req.url.endsWith('points') ? { points: '8.00000000' }
        : { code: 0, message: 'Checkin! Got 8 points' }))
  })
  fixture.listen(0, '127.0.0.1')
  await once(fixture, 'listening')
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`
  const portProbe = http.createServer()
  portProbe.listen(0, '127.0.0.1')
  await once(portProbe, 'listening')
  const port = portProbe.address().port
  await new Promise((resolve) => portProbe.close(resolve))
  const origin = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(port), DATABASE_PATH: ':memory:',
      ADMIN_USER: 'fixture-admin', ADMIN_PASSWORD: 'fixture-password',
      APP_SECRET: 'fixture-only', SESSION_SECRET: 'fixture-session-only',
      GLADOS_ORIGIN: fixtureUrl, CHECKIN_INTERVAL_MS: '0', RETRY_DELAY_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let childLog = ''
  child.stdout.on('data', (data) => { childLog += data })
  child.stderr.on('data', (data) => { childLog += data })
  let cookie = ''
  async function api(path, { method = 'GET', body, authenticated = true } = {}) {
    const response = await fetch(`${origin}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(authenticated && cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(3000),
    })
    return { response, data: await response.json() }
  }
  async function wait(id) {
    for (let i = 0; i < 100; i += 1) {
      const { data } = await api(`/api/jobs/${id}`)
      if (data.job.status === 'completed') return data.job.result
      assert.notEqual(data.job.status, 'failed', data.job.error)
      await sleep(30)
    }
    assert.fail('job timeout')
  }
  try {
    let ready = false
    for (let i = 0; i < 100; i += 1) {
      try { await api('/api/auth/me'); ready = true; break } catch { await sleep(40) }
    }
    assert.equal(ready, true, childLog)
    assert.equal((await api('/api/accounts', { authenticated: false })).response.status, 401)
    const auth = await api('/api/auth/login', { method: 'POST', body: { username: 'fixture-admin', password: 'fixture-password' } })
    assert.equal(auth.response.status, 200)
    cookie = auth.response.headers.get('set-cookie').split(';')[0]
    const ids = []
    for (let i = 0; i < 2; i += 1) {
      const { response, data } = await api('/api/accounts', {
        method: 'POST', body: { label: `Fixture ${i}`, sess: `fixture-${i}`, sessSig: `fixture-sig-${i}`, enabled: false },
      })
      assert.equal(response.status, 201)
      assert.equal(data.account.cookieWarningDays, 3)
      assert.equal(data.account.cookieWarningEnabled, true)
      ids.push(data.account.id)
    }
    const settings = await api(`/api/accounts/${ids[0]}`, {
      method: 'PUT', body: { cookieWarningDays: 7, cookieWarningEnabled: false },
    })
    assert.equal(settings.data.account.cookieWarningDays, 7)
    assert.equal(settings.data.account.cookieWarningEnabled, false)
    assert.equal(settings.data.account.enabled, false)
    for (const invalid of [0, 31, 1.5, 'invalid', '']) {
      assert.equal((await api(`/api/accounts/${ids[0]}`, { method: 'PUT', body: { cookieWarningDays: invalid } })).response.status, 400)
    }
    assert.equal((await api(`/api/accounts/${ids[0]}`, { method: 'PUT', body: { cookieWarningEnabled: 'false' } })).response.status, 400)
    const results = await Promise.all([ids[0], ids[0], ids[1]].map((id) => api(`/api/accounts/${id}/checkin`, { method: 'POST' })))
    assert.ok(results.every(({ response }) => response.status === 202))
    assert.equal(results[0].data.job.id, results[1].data.job.id)
    const accounts = await api('/api/accounts')
    assert.ok(accounts.data.accounts.some((account) => account.activeJob?.status === 'queued'))
    const checkins = await Promise.all(results.map(({ data }) => wait(data.job.id)))
    assert.ok(checkins.every((result) => result.status === 'success'))
    assert.equal(peak, 1)
    assert.equal(posts, 2)
    assert.equal((await api('/api/checkins')).data.checkins.length, 2)
    const webhook = await api('/api/webhooks/test', {
      method: 'POST', body: { webhookUrl: `${fixtureUrl}/hook`, webhookSecret: 'fixture-secret' },
    })
    assert.equal(webhook.response.status, 202)
    const progress = await api(`/api/jobs/${webhook.data.job.id}`)
    assert.doesNotMatch(JSON.stringify(progress.data), /fixture-secret/)
    assert.equal((await wait(webhook.data.job.id)).status, 200)
  } finally {
    const exited = once(child, 'exit')
    if (child.exitCode === null) { child.kill(); await exited }
    fixture.closeAllConnections()
    fixture.close()
  }
})
