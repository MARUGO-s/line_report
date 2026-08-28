/**
 * Internal Edge cron authorization.
 *
 * Scheduled functions use `verify_jwt = false` because pg_cron sends an
 * application secret rather than a Supabase user JWT.  Every such handler
 * must therefore call this helper before reading data or causing a side
 * effect.  Authorization fails closed when neither the Edge secret nor the
 * Vault-backed database secret can be verified.
 */

export type CronAuthRpcClient = {
  rpc: (name: string) => PromiseLike<{
    data: unknown
    error?: { message?: string } | null
  }>
}

export type InternalCronAuthOptions = {
  /** Test hook. Omit in production to read Deno.env.CRON_AUTH_TOKEN. */
  edgeToken?: string
}

export function extractBearerToken(req: Request): string {
  const authorization = String(req.headers.get("Authorization") ?? "").trim()
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return String(match?.[1] ?? "").trim()
}

export function constantTimeEqualSecret(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const left = enc.encode(String(a ?? ""))
  const right = enc.encode(String(b ?? ""))
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i]
  return diff === 0
}

export async function isInternalCronAuthorized(
  req: Request,
  supabase: CronAuthRpcClient,
  options: InternalCronAuthOptions = {},
): Promise<boolean> {
  const provided = extractBearerToken(req)
  if (!provided) return false

  const edgeToken = String(
    options.edgeToken !== undefined
      ? options.edgeToken
      : Deno.env.get("CRON_AUTH_TOKEN") ?? "",
  ).trim()
  if (edgeToken && constantTimeEqualSecret(provided, edgeToken)) return true

  try {
    const { data, error } = await supabase.rpc("resolve_edge_cron_auth_token")
    if (error) return false
    const vaultToken = typeof data === "string" ? data.trim() : ""
    return Boolean(vaultToken && constantTimeEqualSecret(provided, vaultToken))
  } catch {
    return false
  }
}
