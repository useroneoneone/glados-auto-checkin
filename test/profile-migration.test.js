import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { userProfile } from '../src/profile.js'

test('existing accounts migrate with redemption disabled and their original values intact', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'glados-migration-')), 'old.sqlite')
  const old = new Database(file)
  old.exec(`CREATE TABLE accounts (id INTEGER PRIMARY KEY, label TEXT, email TEXT,
    imap_host TEXT, imap_port INTEGER, imap_secure INTEGER, imap_user TEXT, imap_password_enc TEXT,
    enabled INTEGER, last_status TEXT, last_message TEXT, last_checked_at TEXT, created_at TEXT, updated_at TEXT);
    INSERT INTO accounts (id,label,email,enabled,last_status,last_message) VALUES (1,'Fixture','fixture@example.test',1,'success','previous result');`)
  old.close()
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const {db} = await import('./src/db.js');
    const row = db.prepare('SELECT label, enabled, auto_exchange_enabled, left_days, plan, last_message FROM accounts WHERE id=1').get();
    console.log(JSON.stringify(row)); db.close();
  `], { encoding: 'utf8', env: { ...process.env, DATABASE_PATH: file, ADMIN_USER: 'fixture', ADMIN_PASSWORD: 'fixture-only' } })
  assert.deepEqual(JSON.parse(output), { label: 'Fixture', enabled: 1, auto_exchange_enabled: 0, left_days: null, plan: null, last_message: 'previous result' })
})

test('profile uses official rounding and does not invent a plan for missing metadata', () => {
  assert.deepEqual(userProfile({ leftDays: '23.500000', vip: 31 }), { leftDays: '23.5', daysLeft: 24, plan: 'Pro' })
  assert.deepEqual(userProfile({ leftDays: '', vip: '' }), { leftDays: null, daysLeft: null, plan: null })
  assert.equal(userProfile({ leftDays: '1', vip: 999 }).plan, null)
})
