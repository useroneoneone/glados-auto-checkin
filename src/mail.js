import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { decrypt } from './crypto.js'

function extractCode(text) {
  const match = String(text || '').match(/(?:^|\D)(\d{6})(?:\D|$)/)
  return match?.[1] || null
}

export async function waitForOtp(account, since, timeoutMs = 120000) {
  const client = new ImapFlow({
    host: account.imap_host,
    port: Number(account.imap_port || 993),
    secure: Boolean(account.imap_secure),
    auth: { user: account.imap_user, pass: decrypt(account.imap_password_enc) },
    logger: false,
  })
  const deadline = Date.now() + timeoutMs
  try {
    await client.connect()
    while (Date.now() < deadline) {
      const lock = await client.getMailboxLock('INBOX')
      try {
        const messages = await client.search({ since: new Date(since) }, { uid: true })
        for (const uid of messages.reverse().slice(0, 20)) {
          const message = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true })
          const parsed = await simpleParser(message.source)
          const from = parsed.from?.text || ''
          const subject = parsed.subject || ''
          const body = [subject, from, parsed.text, parsed.html].filter(Boolean).join('\n')
          if (!/glados/i.test(body) && !/glados/i.test(from)) continue
          const code = extractCode(body)
          if (code) return code
        }
      } finally {
        lock.release()
      }
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }
    throw new Error('等待邮箱验证码超时')
  } finally {
    await client.logout().catch(() => {})
  }
}
