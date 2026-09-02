import 'dotenv/config'

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
}
