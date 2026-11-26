// APNs（Apple Push Notification service）へ、トークン認証（.p8鍵のES256 JWT）で直接送る。
// 鍵・Key ID・Team IDは環境変数（Supabase secrets）からだけ読み、ログや応答には出さない。

export type ApnsConfig = {
  keyId: string
  teamId: string
  privateKeyPem: string
  bundleId: string
}

export type ApnsEnvironment = "sandbox" | "production"

export type NativeDeviceTarget = {
  token: string
  environment: ApnsEnvironment
}

export type ApnsAlertInput = {
  title: string
  body: string
  groupId: number
  messageId: number
  badgeCount?: number | null
}

export type ApnsResult = { ok: boolean; status: number; reason: string }

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

const ID_PATTERN = /^[A-Z0-9]{10}$/
export const APNS_TOKEN_PATTERN = /^[0-9a-f]{64,200}$/
export const MTALK_BUNDLE_ID = "jp.marugo.mTalk"
// Key ID / Team ID are public identifiers (they appear in every JWT header),
// not secrets. Only the .p8 private key is secret and lives in Supabase Vault
// (`chat_apns_private_key`), like the Web Push VAPID config, because the
// project is at the Edge secret limit. Env vars still override when present.
export const DEFAULT_APNS_KEY_ID = "8TN2J6UFY9"
export const DEFAULT_APNS_TEAM_ID = "SQC68A6ZMA"

/** Returns null when native push is not configured; Web Push keeps working. */
export function loadApnsConfig(
  get: (name: string) => string | undefined,
  vaultPrivateKey?: string | null,
): ApnsConfig | null {
  const keyId = String(get("APNS_KEY_ID") || DEFAULT_APNS_KEY_ID).trim()
  const teamId = String(get("APNS_TEAM_ID") || DEFAULT_APNS_TEAM_ID).trim()
  const rawKey = String(get("APNS_PRIVATE_KEY") || vaultPrivateKey || "")
  const privateKeyPem = rawKey.replace(/\\n/g, "\n").replace(/\r/g, "").trim()
  const bundleId = String(get("APNS_BUNDLE_ID") || MTALK_BUNDLE_ID).trim()
  if (!ID_PATTERN.test(keyId) || !ID_PATTERN.test(teamId)) return null
  if (!privateKeyPem.includes("BEGIN PRIVATE KEY") || bundleId !== MTALK_BUNDLE_ID) return null
  return { keyId, teamId, privateKeyPem, bundleId }
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function base64UrlFromJson(value: unknown): string {
  return base64UrlFromBytes(new TextEncoder().encode(JSON.stringify(value)))
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "")
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
  return await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  )
}

/** ES256 provider token. WebCrypto returns the raw r||s form JWT requires. */
export async function createApnsJwt(config: ApnsConfig, issuedAtSeconds: number): Promise<string> {
  const header = base64UrlFromJson({ alg: "ES256", kid: config.keyId })
  const claims = base64UrlFromJson({ iss: config.teamId, iat: issuedAtSeconds })
  const signingInput = `${header}.${claims}`
  const key = await importPrivateKey(config.privateKeyPem)
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  ))
  return `${signingInput}.${base64UrlFromBytes(signature)}`
}

// Apple accepts a provider token for up to 60 minutes; refresh after 50.
const TOKEN_TTL_SECONDS = 50 * 60
let cachedToken: { cacheKey: string; issuedAt: number; jwt: string } | null = null

export async function apnsProviderToken(config: ApnsConfig, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const cacheKey = `${config.teamId}:${config.keyId}`
  if (cachedToken && cachedToken.cacheKey === cacheKey && nowSeconds - cachedToken.issuedAt < TOKEN_TTL_SECONDS) {
    return cachedToken.jwt
  }
  const jwt = await createApnsJwt(config, nowSeconds)
  cachedToken = { cacheKey, issuedAt: nowSeconds, jwt }
  return jwt
}

export function resetApnsTokenCacheForTests(): void {
  cachedToken = null
}

export function buildApnsPayload(input: ApnsAlertInput): Record<string, unknown> {
  const title = String(input.title ?? "").trim() || "M-talk"
  const body = String(input.body ?? "").trim() || "新しいメッセージがあります"
  const aps: Record<string, unknown> = {
    alert: { title, body },
    sound: "default",
    "thread-id": `chat-group-${input.groupId}`,
  }
  const badge = input.badgeCount == null ? Number.NaN : Number(input.badgeCount)
  if (Number.isSafeInteger(badge) && badge >= 0) aps.badge = badge
  return { aps, group_id: input.groupId, message_id: input.messageId }
}

export function apnsHost(environment: ApnsEnvironment): string {
  return environment === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com"
}

export async function sendApns(
  target: NativeDeviceTarget,
  payload: Record<string, unknown>,
  config: ApnsConfig,
  options: { fetchImpl?: FetchLike; collapseId?: string; nowSeconds?: number } = {},
): Promise<ApnsResult> {
  if (!APNS_TOKEN_PATTERN.test(target.token)) return { ok: false, status: 0, reason: "BadDeviceToken" }
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const jwt = await apnsProviderToken(config, options.nowSeconds)
  const headers: Record<string, string> = {
    authorization: `bearer ${jwt}`,
    "apns-topic": config.bundleId,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "content-type": "application/json",
  }
  const collapseId = String(options.collapseId ?? "").slice(0, 64)
  if (collapseId) headers["apns-collapse-id"] = collapseId
  const response = await fetchImpl(`https://${apnsHost(target.environment)}/3/device/${target.token}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })
  if (response.ok) return { ok: true, status: response.status, reason: "" }
  let reason = ""
  try {
    const parsed = await response.json()
    reason = String(parsed?.reason ?? "")
  } catch {
    reason = ""
  }
  return { ok: false, status: response.status, reason }
}

/** Token is permanently unusable; the device row must stop receiving. */
export function apnsDeviceExpired(result: ApnsResult): boolean {
  return result.status === 410 ||
    result.reason === "BadDeviceToken" ||
    result.reason === "Unregistered" ||
    result.reason === "DeviceTokenNotForTopic"
}

/** Log-safe token suffix; full tokens never go to logs. */
export function tokenHint(token: string): string {
  return `…${String(token ?? "").slice(-6)}`
}
