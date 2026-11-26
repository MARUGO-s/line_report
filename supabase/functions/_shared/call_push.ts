// Outgoing push delivery for incoming voice calls:
// - iOS: APNs VoIP Push (PushKit -> CallKit) using the existing .p8 APNs Auth Key
// - Android: FCM HTTP v1 high-priority data message using a Firebase Service Account JSON

const APNS_ID_PATTERN = /^[A-Z0-9]{10}$/
export const IOS_VOIP_TOKEN_PATTERN = /^[0-9a-f]{64,200}$/i
export const ANDROID_FCM_TOKEN_PATTERN = /^[A-Za-z0-9:_-]{32,512}$/
export const MTALK_IOS_BUNDLE_ID = "jp.marugo.mTalk"
export const MTALK_ANDROID_PACKAGE = "jp.marugo.m_talk"
export const DEFAULT_APNS_KEY_ID = "8TN2J6UFY9"
export const DEFAULT_APNS_TEAM_ID = "SQC68A6ZMA"

export type ApnsVoipConfig = {
  keyId: string
  teamId: string
  privateKeyPem: string
  voipTopic: string
}

export type FcmServiceAccount = {
  projectId: string
  clientEmail: string
  privateKeyPem: string
}

export type CallPushPayload = {
  type: "incoming_call" | "call_canceled"
  callId: string
  groupId: number
  callerId: string
  callerName: string
  roomName: string
  callType?: "audio" | "video"
  expiresAtUnix: number
}

export type PushSendResult = {
  ok: boolean
  status: number
  reason: string
  expired: boolean
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function base64UrlFromJson(value: unknown): string {
  return base64UrlFromBytes(new TextEncoder().encode(JSON.stringify(value)))
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "")
  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

export function loadApnsVoipConfig(
  get: (name: string) => string | undefined,
  vaultPrivateKey?: string | null,
): ApnsVoipConfig | null {
  const keyId = String(get("APNS_KEY_ID") || DEFAULT_APNS_KEY_ID).trim()
  const teamId = String(get("APNS_TEAM_ID") || DEFAULT_APNS_TEAM_ID).trim()
  const rawKey = String(get("APNS_PRIVATE_KEY") || vaultPrivateKey || "")
  const privateKeyPem = rawKey.replace(/\\n/g, "\n").replace(/\r/g, "").trim()
  const bundleId = String(get("APNS_BUNDLE_ID") || MTALK_IOS_BUNDLE_ID).trim()
  if (!APNS_ID_PATTERN.test(keyId) || !APNS_ID_PATTERN.test(teamId)) return null
  if (!privateKeyPem.includes("BEGIN PRIVATE KEY") || bundleId !== MTALK_IOS_BUNDLE_ID) return null
  return {
    keyId,
    teamId,
    privateKeyPem,
    voipTopic: `${bundleId}.voip`,
  }
}

export function parseFcmServiceAccount(rawJson?: string | null): FcmServiceAccount | null {
  const text = String(rawJson ?? "").trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const projectId = String(parsed.project_id ?? "").trim()
    const clientEmail = String(parsed.client_email ?? "").trim()
    const privateKeyPem = String(parsed.private_key ?? "")
      .replace(/\\n/g, "\n")
      .replace(/\r/g, "")
      .trim()
    if (!projectId || !clientEmail || !privateKeyPem.includes("BEGIN PRIVATE KEY")) {
      return null
    }
    return { projectId, clientEmail, privateKeyPem }
  } catch {
    return null
  }
}

let cachedApnsJwt: { key: string; issuedAt: number; jwt: string } | null = null

async function getApnsJwt(config: ApnsVoipConfig, nowSeconds: number): Promise<string> {
  const cacheKey = `${config.teamId}:${config.keyId}`
  if (cachedApnsJwt && cachedApnsJwt.key === cacheKey && nowSeconds - cachedApnsJwt.issuedAt < 50 * 60) {
    return cachedApnsJwt.jwt
  }
  const header = base64UrlFromJson({ alg: "ES256", kid: config.keyId })
  const claims = base64UrlFromJson({ iss: config.teamId, iat: nowSeconds })
  const signingInput = `${header}.${claims}`
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(config.privateKeyPem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      cryptoKey,
      new TextEncoder().encode(signingInput),
    ),
  )
  const jwt = `${signingInput}.${base64UrlFromBytes(signature)}`
  cachedApnsJwt = { key: cacheKey, issuedAt: nowSeconds, jwt }
  return jwt
}

export async function sendApnsVoipPush(
  target: { token: string; environment: "sandbox" | "production" },
  payload: CallPushPayload,
  config: ApnsVoipConfig,
  options: { fetchImpl?: FetchLike; nowSeconds?: number } = {},
): Promise<PushSendResult> {
  if (!IOS_VOIP_TOKEN_PATTERN.test(target.token)) {
    return { ok: false, status: 0, reason: "BadDeviceToken", expired: true }
  }
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  const jwt = await getApnsJwt(config, nowSeconds)
  const host = target.environment === "production"
    ? "api.push.apple.com"
    : "api.sandbox.push.apple.com"

  const body = {
    type: payload.type,
    call_id: payload.callId,
    group_id: payload.groupId,
    caller_id: payload.callerId,
    caller_name: payload.callerName,
    room_name: payload.roomName,
    call_type: payload.callType ?? "audio",
    expires_at: payload.expiresAtUnix,
  }

  const response = await fetchImpl(`https://${host}/3/device/${target.token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": config.voipTopic,
      "apns-push-type": "voip",
      "apns-priority": "10",
      "apns-expiration": String(Math.max(nowSeconds + 5, payload.expiresAtUnix)),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })

  if (response.ok) {
    return { ok: true, status: response.status, reason: "", expired: false }
  }
  let reason = ""
  try {
    const parsed = await response.json()
    reason = String(parsed?.reason ?? "")
  } catch {
    reason = ""
  }
  const expired = response.status === 410 ||
    reason === "BadDeviceToken" ||
    reason === "Unregistered" ||
    reason === "DeviceTokenNotForTopic"
  return { ok: false, status: response.status, reason, expired }
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
let cachedFcmToken: { email: string; token: string; expiresAtMs: number } | null = null

async function getFcmAccessToken(
  account: FcmServiceAccount,
  fetchImpl: FetchLike,
  nowMs: number,
): Promise<string> {
  if (
    cachedFcmToken &&
    cachedFcmToken.email === account.clientEmail &&
    cachedFcmToken.expiresAtMs > nowMs + 60_000
  ) {
    return cachedFcmToken.token
  }
  const nowSec = Math.floor(nowMs / 1000)
  const header = base64UrlFromJson({ alg: "RS256", typ: "JWT" })
  const claims = base64UrlFromJson({
    iss: account.clientEmail,
    scope: FCM_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  })
  const unsigned = `${header}.${claims}`
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(account.privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)),
  )
  const assertion = `${unsigned}.${base64UrlFromBytes(signature)}`
  const form = new URLSearchParams()
  form.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer")
  form.set("assertion", assertion)
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  })
  if (!res.ok) {
    throw new Error(`FCM OAuth failed (${res.status})`)
  }
  const json = await res.json()
  const token = String(json?.access_token ?? "")
  if (!token) throw new Error("FCM OAuth missing access_token")
  cachedFcmToken = { email: account.clientEmail, token, expiresAtMs: nowMs + 3600_000 }
  return token
}

export async function sendFcmCallPush(
  fcmToken: string,
  payload: CallPushPayload,
  account: FcmServiceAccount,
  options: { fetchImpl?: FetchLike; nowMs?: number } = {},
): Promise<PushSendResult> {
  if (!ANDROID_FCM_TOKEN_PATTERN.test(fcmToken)) {
    return { ok: false, status: 0, reason: "INVALID_ARGUMENT", expired: true }
  }
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const nowMs = options.nowMs ?? Date.now()
  const accessToken = await getFcmAccessToken(account, fetchImpl, nowMs)
  const ttlSec = Math.max(10, Math.min(120, payload.expiresAtUnix - Math.floor(nowMs / 1000)))

  const message = {
    message: {
      token: fcmToken,
      android: {
        priority: "HIGH",
        ttl: `${ttlSec}s`,
      },
      data: {
        type: payload.type,
        call_id: payload.callId,
        group_id: String(payload.groupId),
        caller_id: payload.callerId,
        caller_name: payload.callerName,
        room_name: payload.roomName,
        call_type: payload.callType ?? "audio",
        expires_at: String(payload.expiresAtUnix),
      },
    },
  }

  const response = await fetchImpl(
    `https://fcm.googleapis.com/v1/projects/${account.projectId}/messages:send`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(message),
    },
  )

  if (response.ok) {
    return { ok: true, status: response.status, reason: "", expired: false }
  }
  let reason = ""
  try {
    const parsed = await response.json()
    const details = Array.isArray(parsed?.error?.details) ? parsed.error.details : []
    const fcmError = details.find((d: Record<string, unknown>) => typeof d?.errorCode === "string")
    reason = String(fcmError?.errorCode ?? parsed?.error?.status ?? "")
  } catch {
    reason = ""
  }
  const expired = response.status === 404 || reason === "UNREGISTERED" || reason === "INVALID_ARGUMENT"
  return { ok: false, status: response.status, reason, expired }
}

export async function sendFcmChatMessage(
  fcmToken: string,
  payload: {
    title: string
    body: string
    groupId: number
    messageId: number
  },
  account: FcmServiceAccount,
  options: { fetchImpl?: FetchLike; nowMs?: number } = {},
): Promise<PushSendResult> {
  if (!ANDROID_FCM_TOKEN_PATTERN.test(fcmToken)) {
    return { ok: false, status: 0, reason: "INVALID_ARGUMENT", expired: true }
  }
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const nowMs = options.nowMs ?? Date.now()
  const accessToken = await getFcmAccessToken(account, fetchImpl, nowMs)

  const message = {
    message: {
      token: fcmToken,
      android: {
        priority: "HIGH",
        collapse_key: `chat-group-${payload.groupId}`,
      },
      data: {
        type: "chat_message",
        title: String(payload.title || "M-talk"),
        body: String(payload.body || "新しいメッセージがあります"),
        group_id: String(payload.groupId),
        message_id: String(payload.messageId),
      },
    },
  }

  const response = await fetchImpl(
    `https://fcm.googleapis.com/v1/projects/${account.projectId}/messages:send`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(message),
    },
  )

  if (response.ok) {
    return { ok: true, status: response.status, reason: "", expired: false }
  }
  let reason = ""
  try {
    const parsed = await response.json()
    const details = Array.isArray(parsed?.error?.details) ? parsed.error.details : []
    const fcmError = details.find((d: Record<string, unknown>) => typeof d?.errorCode === "string")
    reason = String(fcmError?.errorCode ?? parsed?.error?.status ?? "")
  } catch {
    reason = ""
  }
  const expired = response.status === 404 || reason === "UNREGISTERED" || reason === "INVALID_ARGUMENT"
  return { ok: false, status: response.status, reason, expired }
}
