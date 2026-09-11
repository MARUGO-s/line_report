// No LINE tokens or upstream response bodies may leave this module.
export type UsageChannel = { label: string; token: string }
type FetchLike = typeof fetch
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

export async function fetchLineQuotaChannels(channels: UsageChannel[], fetcher: FetchLike = fetch) {
  const groups = new Map<string, string[]>()
  const missing: string[] = []
  for (const { label, token } of channels) {
    if (!token.trim()) { missing.push(label); continue }
    const labels = groups.get(token) ?? []
    if (!labels.includes(label)) labels.push(label)
    groups.set(token, labels)
  }
  const entries = Array.from(groups.entries())
  const results: Array<Record<string, unknown>> = []
  // Bounded concurrency. Only on explicit refresh; not in every /state poll.
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (next < entries.length) {
      const [token, labels] = entries[next++]
      const get = async (path: string) => {
        const response = await fetcher(`https://api.line.me/v2/bot/message/${path}`, {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
        })
        if (!response.ok) throw new Error('upstream_unavailable')
        return await response.json()
      }
      try {
        const [quota, consumption] = await Promise.all([get('quota'), get('quota/consumption')])
        if (!count(consumption?.totalUsage) || !['limited','none'].includes(quota?.type) ||
          (quota.type === 'limited' && !count(quota.value))) throw new Error('invalid_response')
        const limit = quota.type === 'limited' ? quota.value : null
        results.push({ labels, status: 'ok', used: consumption.totalUsage, limit,
          remaining: limit === null ? null : Math.max(0, limit - consumption.totalUsage) })
      } catch {
        results.push({ labels, status: 'unavailable', used: null, limit: null, remaining: null })
      }
    }
  }))
  for (const label of missing) results.push({ labels: [label], status: 'not_configured', used: null, limit: null, remaining: null })
  return { source: 'line_quota_api', approximate: true, generated_at: new Date().toISOString(),
    channels: results.sort((a,b) => String(a.labels).localeCompare(String(b.labels),'ja')) }
}

export async function fetchMonthlyUsage(supabase: { rpc: (name: string) => PromiseLike<{ data: unknown; error: unknown }> }) {
  try {
    const { data, error } = await supabase.rpc('get_usage_monthly')
    const row = data as Record<string, unknown> | null
    if (error || !row || row.status !== 'ok' || !count(row.total_push_rows) || !count(row.webhook_reply_rows) ||
      !Array.isArray(row.by_store) || !Array.isArray(row.by_room) || !Array.isArray(row.by_source_context)) throw new Error('invalid_usage')
    return row
  } catch {
    return { status: 'unavailable', generated_at: new Date().toISOString(),
      total_push_rows: null, webhook_reply_rows: null,
      error: '配信記録を取得できません。再読込してください。' }
  }
}
