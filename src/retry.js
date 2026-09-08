import { setTimeout as sleep } from 'node:timers/promises'

export function transientError(error) {
  if (typeof error?.retryable === 'boolean') return error.retryable
  if (error?.status) return error.status === 408 || error.status === 429 || error.status >= 500
  return /timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed/i
    .test(`${error?.name} ${error?.message} ${error?.cause?.code || ''}`)
}

export function httpError(label, status, retryAfter) {
  const error = new Error(`${label} HTTP ${status}`)
  error.status = status
  if (retryAfter) {
    const seconds = Number(retryAfter)
    const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now()
    if (Number.isFinite(wait)) error.retryAfterMs = Math.min(60000, Math.max(0, wait))
  }
  return error
}

export async function withRetry(operation, { attempts = 3, delayMs = 1000, wait = sleep } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt)
    } catch (error) {
      if (attempt >= attempts || !transientError(error)) throw error
      await wait(Math.max(delayMs * 2 ** (attempt - 1), error.retryAfterMs || 0))
    }
  }
}
