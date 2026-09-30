import test, { after } from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_PATH = ':memory:'
process.env.ADMIN_USER = 'points-fixture'
process.env.ADMIN_PASSWORD = 'points-fixture-password'
const { db, accountPublic } = await import('../src/db.js')
after(() => db.close())

test('account balance survives missing results and the history limit, remains isolated, and includes zero', () => {
  const insertAccount = db.prepare(`INSERT INTO accounts (label, email, imap_host, imap_user, imap_password_enc, created_at, updated_at)
    VALUES (?, '', '', '', '', '2026-10-01', '2026-10-01')`)
  const firstId = insertAccount.run('First').lastInsertRowid
  const secondId = insertAccount.run('Second').lastInsertRowid
  const read = (id) => accountPublic(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id))
  const insert = db.prepare('INSERT INTO checkins (account_id, status, points, checked_at) VALUES (?, ?, ?, ?)')
  assert.equal(read(firstId).currentPoints, null)
  assert.equal(read(firstId).pointsUpdatedAt, null)
  insert.run(firstId, 'success', '125.500000', '2026-10-01T01:00:00Z')
  for (let i = 0; i < 105; i++) insert.run(secondId, 'success', '999', '2026-10-01T02:00:00Z')
  for (const [status, points] of [['failed', '111'], ['success', null], ['already_signed', '  ']]) {
    insert.run(firstId, status, points, '2026-10-01T03:00:00Z')
  }
  assert.equal(read(firstId).currentPoints, '125.500000')
  assert.equal(read(firstId).pointsUpdatedAt, '2026-10-01T01:00:00Z')
  assert.equal(read(secondId).currentPoints, '999')
  insert.run(firstId, 'already_signed', '0', '2026-10-01T04:00:00Z')
  assert.equal(read(firstId).currentPoints, '0')
  assert.equal(read(firstId).pointsUpdatedAt, '2026-10-01T04:00:00Z')
})
