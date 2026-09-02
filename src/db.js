import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import { config } from './config.js'

fs.mkdirSync(path.dirname(path.resolve(config.databasePath)), { recursive: true })
export const db = new Database(config.databasePath)
db.pragma('foreign_keys = ON')
db.pragma('journal_mode = WAL')
db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  email TEXT NOT NULL,
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL DEFAULT 993,
  imap_secure INTEGER NOT NULL DEFAULT 1,
  imap_user TEXT NOT NULL,
  imap_password_enc TEXT NOT NULL,
  webhook_url TEXT,
  webhook_secret_enc TEXT,
  cookie_enc TEXT,
  cookie_expires_at TEXT,
  storage_state_enc TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_status TEXT,
  last_message TEXT,
  last_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  points TEXT,
  points_change TEXT,
  left_days TEXT,
  raw_json TEXT,
  checked_at TEXT NOT NULL,
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
`)

const accountColumns = db.prepare('PRAGMA table_info(accounts)').all().map((column) => column.name)
if (!accountColumns.includes('cookie_enc')) db.prepare('ALTER TABLE accounts ADD COLUMN cookie_enc TEXT').run()
if (!accountColumns.includes('cookie_expires_at')) db.prepare('ALTER TABLE accounts ADD COLUMN cookie_expires_at TEXT').run()
if (!accountColumns.includes('cookie_sess_enc')) db.prepare('ALTER TABLE accounts ADD COLUMN cookie_sess_enc TEXT').run()
if (!accountColumns.includes('cookie_sess_sig_enc')) db.prepare('ALTER TABLE accounts ADD COLUMN cookie_sess_sig_enc TEXT').run()
if (!accountColumns.includes('schedule_time')) db.prepare("ALTER TABLE accounts ADD COLUMN schedule_time TEXT NOT NULL DEFAULT '07:15'").run()
if (!accountColumns.includes('schedule_timezone')) db.prepare("ALTER TABLE accounts ADD COLUMN schedule_timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai'").run()
if (!accountColumns.includes('last_scheduled_date')) db.prepare('ALTER TABLE accounts ADD COLUMN last_scheduled_date TEXT').run()
db.prepare("UPDATE accounts SET last_message = '检测失败：网络连接中断' WHERE last_message LIKE '%cookie:%'").run()
db.prepare("UPDATE checkins SET message = '执行失败：网络连接中断' WHERE message LIKE '%cookie:%'").run()

const existingAdmin = db.prepare('SELECT id FROM admins WHERE username = ?').get(config.adminUser)
if (!existingAdmin) {
  db.prepare('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(config.adminUser, bcrypt.hashSync(config.adminPassword, 12), new Date().toISOString())
}

export function accountPublic(row) {
  if (!row) return null
  const lastMessage = String(row.last_message || '')
    .replace(/koa:sess(?:\.sig)?=[^;\s]+/gi, 'koa:sess=[已隐藏]')
    .split('\n').filter((line) => !/^\s*-\s*cookie:/i.test(line)).join('\n').slice(0, 500)
  return {
    id: row.id,
    label: row.label,
    email: row.email,
    imapHost: row.imap_host,
    imapPort: row.imap_port,
    imapSecure: Boolean(row.imap_secure),
    imapUser: row.imap_user,
    webhookUrl: row.webhook_url || '',
    hasCookie: Boolean((row.cookie_sess_enc && row.cookie_sess_sig_enc) || row.cookie_enc),
    hasCookieSess: Boolean(row.cookie_sess_enc),
    hasCookieSessSig: Boolean(row.cookie_sess_sig_enc),
    cookieExpiresAt: row.cookie_expires_at,
    scheduleTime: row.schedule_time || '07:15',
    scheduleTimezone: row.schedule_timezone || 'Asia/Shanghai',
    enabled: Boolean(row.enabled),
    lastStatus: row.last_status,
    lastMessage,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
  }
}
