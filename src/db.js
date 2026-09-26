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
CREATE TABLE IF NOT EXISTS cookie_warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  cookie_expires_at TEXT NOT NULL,
  phase TEXT NOT NULL,
  period_key TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  status TEXT NOT NULL,
  last_attempt_at TEXT NOT NULL,
  sent_at TEXT,
  last_error TEXT,
  UNIQUE(account_id, cookie_expires_at, phase, period_key),
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
`)

const accountColumns = db.prepare('PRAGMA table_info(accounts)').all().map((column) => column.name)
if (!accountColumns.includes('cookie_enc')) db.prepare('ALTER TABLE accounts ADD COLUMN cookie_enc TEXT').run()
if (!accountColumns.includes('cookie_expires_at')) db.prepare('ALTER TABLE accounts ADD COLUMN cookie_expires_at TEXT').run()
if (!accountColumns.includes('cookie_sess_enc')) db.prepare('ALTER TABLE accounts ADD COLUMN cookie_sess_enc TEXT').run()
if (!accountColumns.includes('cookie_sess_sig_enc')) db.prepare('ALTER TABLE accounts ADD COLUMN cookie_sess_sig_enc TEXT').run()
if (!accountColumns.includes('cookie_namespace')) db.exec("ALTER TABLE accounts ADD COLUMN cookie_namespace TEXT NOT NULL DEFAULT 'koa'")
if (!accountColumns.includes('checkin_method')) db.exec("ALTER TABLE accounts ADD COLUMN checkin_method TEXT NOT NULL DEFAULT 'http'")
if (!accountColumns.includes('cookie_format_version')) db.exec('ALTER TABLE accounts ADD COLUMN cookie_format_version INTEGER NOT NULL DEFAULT 0')
db.prepare("UPDATE accounts SET checkin_method = 'http' WHERE checkin_method <> 'http'").run()
if (!accountColumns.includes('schedule_time')) db.prepare("ALTER TABLE accounts ADD COLUMN schedule_time TEXT NOT NULL DEFAULT '07:15'").run()
if (!accountColumns.includes('schedule_timezone')) db.prepare("ALTER TABLE accounts ADD COLUMN schedule_timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai'").run()
if (!accountColumns.includes('last_scheduled_date')) db.prepare('ALTER TABLE accounts ADD COLUMN last_scheduled_date TEXT').run()
if (!accountColumns.includes('cookie_warning_enabled')) db.prepare('ALTER TABLE accounts ADD COLUMN cookie_warning_enabled INTEGER NOT NULL DEFAULT 1').run()
if (!accountColumns.includes('cookie_warning_days')) db.prepare('ALTER TABLE accounts ADD COLUMN cookie_warning_days INTEGER NOT NULL DEFAULT 3').run()
for (const [name, type] of Object.entries({ schedule_end_time: 'TEXT', schedule_plan_date: 'TEXT', schedule_plan_minute: 'INTEGER' })) {
  if (!accountColumns.includes(name)) db.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${type}`)
}

db.prepare("UPDATE accounts SET last_message = '检测失败：网络连接中断' WHERE last_message LIKE '%cookie:%'").run()
db.prepare("UPDATE checkins SET message = '执行失败：网络连接中断' WHERE message LIKE '%cookie:%'").run()

const existingAdmin = db.prepare('SELECT id FROM admins WHERE username = ?').get(config.adminUser)
if (!existingAdmin) {
  db.prepare('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(config.adminUser, bcrypt.hashSync(config.adminPassword, 12), new Date().toISOString())
}

export function accountPublic(row) {
  if (!row) return null
  const warning = row.cookie_expires_at ? db.prepare(`SELECT status, sent_at, last_error FROM cookie_warnings
    WHERE account_id = ? AND cookie_expires_at = ? ORDER BY id DESC LIMIT 1`).get(row.id, row.cookie_expires_at) : null
  const lastMessage = String(row.last_message || '')
    .replace(/(?:koa|gld):sess(?:\.sig)?=[^;\s]+/gi, 'session=[已隐藏]')
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
    hasCookie: Number(row.cookie_format_version) >= 4 && Boolean(row.cookie_enc),
    hasFullCookie: Number(row.cookie_format_version) >= 4 && Boolean(row.cookie_enc),
    checkinMethod: row.checkin_method || 'http',
    cookieExpiresAt: row.cookie_expires_at,
    cookieWarningEnabled: Boolean(row.cookie_warning_enabled),
    cookieWarningDays: row.cookie_warning_days,
    cookieWarningStatus: warning?.status || null,
    cookieWarningSentAt: warning?.sent_at || null,
    cookieWarningError: warning?.last_error || null,
    scheduleTime: row.schedule_time || '07:15',
    scheduleEndTime: row.schedule_end_time || row.schedule_time || '07:15',
    scheduledDate: row.schedule_plan_date,
    scheduledTime: row.schedule_plan_minute == null ? null : `${String(Math.floor(row.schedule_plan_minute / 60) % 24).padStart(2, '0')}:${String(row.schedule_plan_minute % 60).padStart(2, '0')}`,
    scheduleTimezone: row.schedule_timezone || 'Asia/Shanghai',
    enabled: Boolean(row.enabled),
    lastStatus: row.last_status,
    lastMessage,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
  }
}
