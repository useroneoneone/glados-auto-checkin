// Match the official check-in page: Math.round(leftDays), and its VIP labels.
export function userProfile(data = {}) {
  const raw = data.leftDays
  const days = raw == null || String(raw).trim() === '' ? NaN : Number(raw)
  const vip = data.vip == null || String(data.vip).trim() === '' ? NaN : Number(data.vip)
  const plans = { 0: 'Free', 10: 'Free', 11: 'Edu', 21: 'Basic', 31: 'Pro', 41: 'Team', 51: 'Enterprise' }
  return {
    leftDays: Number.isFinite(days) ? String(days) : null,
    daysLeft: Number.isFinite(days) ? Math.round(days) : null,
    plan: Number.isFinite(vip) ? (plans[vip] || 'Basic') : null,
  }
}

export function saveAccountProfile(database, accountId, profile) {
  if (profile?.leftDays == null && profile?.plan == null) return
  database.prepare(`UPDATE accounts SET left_days = COALESCE(?, left_days),
    plan = COALESCE(?, plan), profile_updated_at = ? WHERE id = ?`)
    .run(profile.leftDays ?? null, profile.plan ?? null, new Date().toISOString(), accountId)
}
