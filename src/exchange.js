import { safeErrorMessage } from './errors.js'

export function longestAffordablePlan(snapshot) {
  const disabled = value => value === false || value === 0 || value === 'false' || value === '0'
  return Object.entries(snapshot.plans || {}).map(([planType, plan]) => ({
    planType, days: Number(plan?.days), cost: Number(plan?.points),
    available: !disabled(plan?.enabled) && !disabled(plan?.enable) && !disabled(plan?.available),
  })).filter(plan => /^[a-zA-Z0-9_-]{1,80}$/.test(plan.planType) && plan.available
    && Number.isSafeInteger(plan.days) && plan.days > 0
    && Number.isFinite(plan.cost) && plan.cost > 0 && plan.cost <= Number(snapshot.points))
    .sort((a, b) => b.days - a.days || a.cost - b.cost)[0] || null
}

function applySnapshot(result, snapshot) {
  if (snapshot.leftDays != null) result.leftDays = snapshot.leftDays
  if (snapshot.plan != null) result.plan = snapshot.plan
  if (snapshot.points != null) result.points = snapshot.points
}

function verifiedExchange(attempt, snapshot) {
  const before = JSON.parse(attempt.before_json)
  // The site's ledger records exchanges as system:ex:planType:YYYY-MM-DD.
  // Match a NEW ledger ID, not an old deduction or another type of spending.
  return before.historyKnown && Array.isArray(snapshot.history) && snapshot.history.some(entry => entry.id != null
    && !before.historyIds.includes(String(entry.id))
    && Number.isFinite(Number(entry.time)) && Number(entry.time) >= Date.parse(attempt.created_at) - 5000
    && String(entry.business || '').startsWith(`system:ex:${attempt.plan_type}:`)
    && Math.abs(Number(entry.change) + attempt.cost) < 0.000001)
}

export async function autoExchange({ database, accountId, client, result }) {
  const enabled = () => {
    const account = database.prepare('SELECT enabled, auto_exchange_enabled FROM accounts WHERE id = ?').get(accountId)
    return Boolean(account?.enabled && account.auto_exchange_enabled)
  }
  if (!enabled()) return
  const describe = exchange => {
    result.exchange = exchange
    result.message = `${result.message || ''}；自动兑换：${exchange.message}`
  }
  let snapshot
  try {
    // Always read after check-in: importing metadata or an earlier snapshot never triggers spending.
    snapshot = await client.exchangeSnapshot()
    applySnapshot(result, snapshot)
  } catch (error) {
    describe({ status: 'failed', message: `查询失败，未提交兑换：${safeErrorMessage(error)}` })
    return
  }
  if (!enabled()) return
  const previous = database.prepare('SELECT * FROM exchanges WHERE account_id = ? AND guard_active = 1 ORDER BY id DESC LIMIT 1').get(accountId)
  if (previous) {
    if (previous.status === 'success') {
      if (snapshot.daysLeft !== 1 && snapshot.daysLeft != null) {
        database.prepare('UPDATE exchanges SET guard_active = 0 WHERE id = ?').run(previous.id)
      } else {
        describe({ status: 'skipped', message: '本次续期已兑换，等待官网天数更新' })
        return
      }
    } else {
      const verified = verifiedExchange(previous, snapshot)
      const message = verified ? `已核实兑换成功：${previous.cost} 积分 → ${previous.days} 天`
        : '上次请求结果仍待确认，已阻止再次提交；请核实官网兑换记录'
      database.prepare('UPDATE exchanges SET status = ?, message = ?, updated_at = ? WHERE id = ?')
        .run(verified ? 'success' : 'unknown', message, new Date().toISOString(), previous.id)
      describe({ status: verified ? 'success' : 'unknown', verified, planType: previous.plan_type, days: previous.days, cost: previous.cost, message })
      return
    }
  }
  if (snapshot.daysLeft !== 1) return
  const plan = longestAffordablePlan(snapshot)
  if (!plan) {
    describe({ status: 'skipped', message: '当前积分不足或没有可用兑换档位' })
    return
  }
  if (!enabled()) return
  const now = new Date().toISOString()
  // Persist BEFORE POST. An interrupted process will verify this record on the next run.
  const id = database.prepare(`INSERT INTO exchanges
    (account_id, plan_type, days, cost, status, before_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`)
    .run(accountId, plan.planType, plan.days, plan.cost, JSON.stringify({
      historyKnown: Array.isArray(snapshot.history),
      historyIds: (snapshot.history || []).filter(x => x.id != null).map(x => String(x.id)),
    }), now, now).lastInsertRowid
  let state = 'unknown'
  let message = '请求结果待确认，已阻止再次提交；请核实官网兑换记录'
  let confirmedByResponse = false
  try {
    const response = await client.exchange(plan.planType)
    if (response.ok && response.payload?.code != null) {
      confirmedByResponse = Number(response.payload.code) === 0
      const balance = response.payload.points
      if (confirmedByResponse && balance != null && String(balance).trim() !== '' && Number.isFinite(Number(balance))) {
        result.points = String(balance).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '')
      }
      state = confirmedByResponse ? 'success' : 'failed'
      message = confirmedByResponse ? `兑换成功：${plan.cost} 积分 → ${plan.days} 天`
        : String(response.payload.message || '官网拒绝兑换').slice(0, 300)
    }
  } catch { /* Ambiguous POST outcomes must be verified, never replayed. */ }
  let refreshed = false
  try {
    const after = await client.exchangeSnapshot({ allowPartial: true })
    applySnapshot(result, after)
    refreshed = !after.readErrors.length
    if (state === 'unknown') {
      const attempt = database.prepare('SELECT * FROM exchanges WHERE id = ?').get(id)
      if (attempt && verifiedExchange(attempt, after)) {
        state = 'success'
        message = `已核实兑换成功：${plan.cost} 积分 → ${plan.days} 天`
      }
    }
    if (!refreshed) message += `；部分属性刷新失败：${after.readErrors.join('；')}`
  } catch (error) {
    message += `；最新天数、套餐及积分刷新失败：${safeErrorMessage(error)}`
  }
  database.prepare('UPDATE exchanges SET status = ?, guard_active = ?, message = ?, updated_at = ? WHERE id = ?')
    .run(state, state === 'failed' ? 0 : 1, message, new Date().toISOString(), id)
  describe({ status: state, planType: plan.planType, days: plan.days, cost: plan.cost,
    verified: state === 'success' && !confirmedByResponse, refreshed, message })
}
