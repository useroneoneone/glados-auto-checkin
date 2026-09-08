import 'dotenv/config'

function integerSetting(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

export const config = {
  port: Number(process.env.PORT || 3000),
  databasePath: process.env.DATABASE_PATH || './data/glados.sqlite',
  appSecret: process.env.APP_SECRET || 'dev-only-change-me',
  sessionSecret: process.env.SESSION_SECRET || 'dev-session-secret-change-me',
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'change-this-password',
  checkinCron: process.env.CHECKIN_CRON || '15 7 * * *',
  checkinTimezone: process.env.CHECKIN_TIMEZONE || process.env.TZ || 'Asia/Shanghai',
  gladosOrigin: process.env.GLADOS_ORIGIN || 'https://glados-facility.com',
  gladosCheckinToken: process.env.GLADOS_CHECKIN_TOKEN || 'glados.cloud',
  checkinIntervalMs: integerSetting('CHECKIN_INTERVAL_MS', 1000, 0, 60000),
  requestTimeoutMs: integerSetting('GLADOS_REQUEST_TIMEOUT_MS', 30000, 100, 120000),
  requestAttempts: integerSetting('GLADOS_REQUEST_ATTEMPTS', 3, 1, 5),
  retryDelayMs: integerSetting('RETRY_DELAY_MS', 1000, 0, 60000),
  webhookTimeoutMs: integerSetting('WEBHOOK_TIMEOUT_MS', 20000, 100, 120000),
  webhookAttempts: integerSetting('WEBHOOK_ATTEMPTS', 3, 1, 5),
}
