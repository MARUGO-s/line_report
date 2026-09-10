// Provider-neutral policy: no secrets, business data, or runtime globals.
export type FoodCourtProvider = 'groq' | 'gemini' | 'claude' | 'openai' | 'grok' | 'moonshot'
export const FOODCOURT_GEMINI_STABLE_MODEL = 'gemini-3.5-flash'

export function foodCourtRoleProvider(role: 'critic' | 'evaluator', override?: string): FoodCourtProvider {
  const value = String(override ?? '').trim().toLowerCase()
  // Moonshot is intentionally excluded from production routing.
  if (['groq', 'gemini', 'claude', 'openai', 'grok'].includes(value)) return value as FoodCourtProvider
  return role === 'critic' ? 'gemini' : 'groq'
}

export function foodCourtGeminiGeneration(model: string, outputTokens: number) {
  return {
    maxOutputTokens: outputTokens,
    // Gemini 3 is tuned for default temperature. Bound thinking instead of forcing 0.1/0.2.
    ...(/^gemini-3(?:\.|-)/.test(model)
      ? { thinkingConfig: { thinkingLevel: 'low' } }
      : { temperature: 0.2 }),
  }
}

export function foodCourtHttpReason(status: number, body = ''): string {
  // Return only an allowlisted label, never an API response that may echo private input.
  if (/credit balance|insufficient[_ ](?:credits|quota)|billing|spend(?:ing)? limit/i.test(body)) return 'billing_limit'
  if (status === 401 || status === 403) return 'auth_error'
  if (status === 404 || /model.{0,80}(?:not found|not exist|decommissioned|retired)/i.test(body)) return 'model_not_found'
  if (status === 429) return 'rate_limited'
  if (status === 400) return 'invalid_request'
  return `http_${status}`
}

export function foodCourtExceptionReason(error: unknown, signal?: AbortSignal): string {
  const name = (error as { name?: unknown })?.name
  if (name === 'SyntaxError') return 'invalid_json'
  if (name === 'TimeoutError' || signal?.reason?.name === 'TimeoutError') return 'timeout'
  if (name === 'AbortError' || signal?.aborted) return 'aborted'
  return 'network_error'
}

// One bounded retry for an explicit transient HTTP rejection. Never retry billing/auth/400,
// or a timeout after inference may already have started. The original deadline is shared.
export async function foodCourtFetch(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, init)
  if (![429, 500, 502, 503, 504].includes(response.status) || init.signal?.aborted) return response
  if (response.status === 429 && foodCourtHttpReason(429, await response.clone().text().catch(() => '')) === 'billing_limit') return response
  const retryAfter = response.headers.get('retry-after')
  const delay = retryAfter == null ? 250 : /^\d+(?:\.\d+)?$/.test(retryAfter)
    ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()
  // Do not ignore a long server backoff or consume the remaining provider budget waiting.
  if (!Number.isFinite(delay) || delay > 1000) return response
  await response.body?.cancel().catch(() => {})
  await new Promise<void>((resolve, reject) => {
    const signal = init.signal
    const done = () => { signal?.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(done, Math.max(250, delay))
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason) }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
  return await fetch(url, init)
}

export function foodCourtProviderTimeout(remaining: number, cap: number, remainingProviders: number): number {
  // Reserve at most 30% for fallbacks: do not starve a healthy primary with a 250ms slot.
  const reserve = remainingProviders > 0 ? Math.min(remaining * 0.3, remainingProviders * 10_000) : 0
  return Math.max(1, Math.floor(Math.min(cap, remaining - reserve)))
}

export function foodCourtStageDeadline(deadlineAt: number, role: string, now: number): number {
  const remaining = Math.max(0, deadlineAt - now)
  if (role.startsWith('specialist_')) return Math.min(deadlineAt - Math.min(65_000, remaining * 0.65), now + 40_000)
  if (role === 'critic') return Math.min(deadlineAt - Math.min(45_000, remaining * 0.65), now + 25_000)
  if (role === 'integrator') return deadlineAt - Math.min(12_000, remaining * 0.25)
  return deadlineAt
}

export function foodCourtImageMime(bytes: Uint8Array, contentType: string | null): string | null {
  // LINE/CDN responses sometimes omit Content-Type or append charset parameters.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (String.fromCharCode(...bytes.slice(0, 3)) === 'GIF') return 'image/gif'
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp'
  const mime = String(contentType ?? '').split(';')[0].trim().toLowerCase().replace('image/jpg', 'image/jpeg')
  return /^image\/(png|jpeg|webp|gif|heic|heif)$/.test(mime) ? mime : null
}

export function foodCourtGeminiText(json: any): string {
  const parts = json?.candidates?.[0]?.content?.parts
  return Array.isArray(parts) ? parts.filter((p: any) => p?.thought !== true && typeof p?.text === 'string').map((p: any) => p.text).join('\n').trim() : ''
}

export type FoodCourtExtractionDiagnostic = { reason: string | null; isTable: boolean | null }

export function foodCourtExtractionDiagnostic(parsed: any, truncated = false): FoodCourtExtractionDiagnostic {
  if (truncated) return { reason: 'output_truncated', isTable: null }
  if (!parsed || !Array.isArray(parsed.tenants)) return { reason: 'invalid_json', isTable: null }
  // Only an explicit, well-formed negative classification counts as a normal non-table.
  if (parsed.is_tenant_table === false && parsed.tenants.length === 0) return { reason: 'not_tenant_table', isTable: false }
  if (parsed.is_tenant_table === false) return { reason: 'invalid_response', isTable: null }
  return { reason: parsed.tenants.length ? null : 'empty_tenants', isTable: parsed.is_tenant_table === true ? true : null }
}

export function foodCourtTenantNeedsFallback(diagnostic: FoodCourtExtractionDiagnostic, markerMatched: boolean): boolean {
  return !(diagnostic.reason === 'not_tenant_table' && !markerMatched)
}
