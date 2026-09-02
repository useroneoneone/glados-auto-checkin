import crypto from 'node:crypto'
import { config } from './config.js'

const key = crypto.createHash('sha256').update(config.appSecret).digest()

export function encrypt(value) {
  if (value == null || value === '') return ''
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.')
}

export function decrypt(value) {
  if (!value) return ''
  const [ivRaw, tagRaw, encryptedRaw] = String(value).split('.')
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error('Invalid encrypted value')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, 'base64url')), decipher.final()]).toString('utf8')
}
