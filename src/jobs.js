import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { safeErrorMessage } from './errors.js'

export class SerialQueue {
  constructor(intervalMs = 0) {
    this.tail = Promise.resolve()
    this.nextAt = 0
    this.intervalMs = intervalMs
  }

  run(operation) {
    const promise = this.tail.then(async () => {
      const remaining = this.nextAt - Date.now()
      if (remaining > 0) await sleep(remaining)
      try { return await operation() } finally { this.nextAt = Date.now() + this.intervalMs }
    })
    this.tail = promise.catch(() => {})
    return promise
  }
}

export class JobRegistry {
  constructor({ intervalMs = 0, onError = () => {} } = {}) {
    this.queue = new SerialQueue(intervalMs)
    this.jobs = new Map()
    this.active = new Map()
    this.onError = onError
  }

  enqueue({ type, accountId = null, source = 'manual' }, operation, after) {
    const key = `${type}:${accountId ?? randomUUID()}`
    const existing = this.active.get(key)
    if (existing) return existing.job
    const job = {
      id: randomUUID(), type, accountId, source, status: 'queued',
      createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      result: null, error: null,
    }
    const entry = { job, done: null }
    this.active.set(key, entry)
    this.jobs.set(job.id, entry)
    // Only the GLaDOS phase holds this queue. Notifications run independently.
    entry.done = this.queue.run(async () => {
      job.status = 'running'
      job.startedAt = new Date().toISOString()
      return operation(job)
    }).then(async (output) => {
      if (after) job.status = 'notifying'
      job.result = after ? await after(output, job) : output
      job.status = 'completed'
    }).catch((error) => {
      job.error = safeErrorMessage(error)
      job.status = 'failed'
      this.onError(job)
    }).finally(() => {
      job.finishedAt = new Date().toISOString()
      this.active.delete(key)
      setTimeout(() => this.jobs.delete(job.id), 30 * 60 * 1000).unref()
    })
    return job
  }

  get(id) { return this.jobs.get(id)?.job }

  forAccount(accountId) {
    const entries = [...this.active.values()].filter(({ job }) => job.accountId === accountId)
    const current = entries.find(({ job }) => job.status === 'running') || entries[0]
    if (!current) return null
    const { id, type, status, source } = current.job
    return { id, type, status, source }
  }

  async wait(id) {
    const entry = this.jobs.get(id)
    if (!entry) throw new Error('任务不存在或已过期')
    await entry.done
    if (entry.job.status === 'failed') throw new Error(entry.job.error)
    return entry.job.result
  }
}
