const encoder = new TextEncoder()

export type WebPushSubscription = {
  endpoint: string
  p256dh: string
  auth: string
}

export type VapidConfig = {
  publicKey: string
  privateKey: string
  subject: string
}

export type WebPushRequest = {
  endpoint: string
  headers: Record<string, string>
  body: Uint8Array
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const output = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.length)
  copy.set(value)
  return copy.buffer
}

export function base64UrlDecode(value: string): Uint8Array {
  const normalized = String(value ?? "").trim().replace(/-/g, "+").replace(/_/g, "/")
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4))
  let binary = ""
  try {
    binary = atob(normalized + padding)
  } catch {
    throw new Error("Invalid base64url value.")
  }
  const output = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) output[i] = binary.charCodeAt(i)
  return output
}

export function base64UrlEncode(value: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < value.length; i += 1) binary += String.fromCharCode(value[i])
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, asArrayBuffer(data)))
}

async function hkdfExtract(salt: Uint8Array, inputKeyMaterial: Uint8Array): Promise<Uint8Array> {
  return await hmacSha256(salt, inputKeyMaterial)
}

async function hkdfExpand(
  pseudoRandomKey: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  if (length < 1 || length > 32) throw new Error("HKDF output length must be between 1 and 32 bytes.")
  const block = await hmacSha256(pseudoRandomKey, concatBytes(info, Uint8Array.of(1)))
  return block.slice(0, length)
}

function validateSubscription(subscription: WebPushSubscription): void {
  const endpoint = String(subscription.endpoint ?? "").trim()
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new Error("Push endpoint is invalid.")
  }
  if (parsed.protocol !== "https:") throw new Error("Push endpoint must use HTTPS.")

  const clientPublicKey = base64UrlDecode(subscription.p256dh)
  if (clientPublicKey.length !== 65 || clientPublicKey[0] !== 4) {
    throw new Error("Push p256dh key must be an uncompressed P-256 public key.")
  }
  const authSecret = base64UrlDecode(subscription.auth)
  if (authSecret.length < 16) throw new Error("Push auth secret is too short.")
}

function normalizeVapidKeys(config: VapidConfig): {
  publicBytes: Uint8Array
  privateBytes: Uint8Array
} {
  const publicBytes = base64UrlDecode(config.publicKey)
  const privateBytes = base64UrlDecode(config.privateKey)
  if (publicBytes.length !== 65 || publicBytes[0] !== 4) {
    throw new Error("CHAT_VAPID_PUBLIC_KEY must be an uncompressed P-256 public key.")
  }
  if (privateBytes.length !== 32) {
    throw new Error("CHAT_VAPID_PRIVATE_KEY must be a 32-byte P-256 private scalar.")
  }
  return { publicBytes, privateBytes }
}

export async function createVapidAuthorization(
  endpoint: string,
  config: VapidConfig,
  now = new Date(),
): Promise<string> {
  const parsedEndpoint = new URL(endpoint)
  if (parsedEndpoint.protocol !== "https:") throw new Error("Push endpoint must use HTTPS.")
  const subject = String(config.subject ?? "").trim()
  if (!/^mailto:.+@.+/i.test(subject) && !/^https:\/\//i.test(subject)) {
    throw new Error("CHAT_VAPID_SUBJECT must be a mailto: or HTTPS URL.")
  }

  const { publicBytes, privateBytes } = normalizeVapidKeys(config)
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })))
  const payload = base64UrlEncode(encoder.encode(JSON.stringify({
    aud: parsedEndpoint.origin,
    exp: Math.floor(now.getTime() / 1000) + (12 * 60 * 60),
    sub: subject,
  })))
  const unsignedToken = `${header}.${payload}`

  const privateKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: base64UrlEncode(publicBytes.slice(1, 33)),
      y: base64UrlEncode(publicBytes.slice(33, 65)),
      d: base64UrlEncode(privateBytes),
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  )
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    encoder.encode(unsignedToken),
  ))
  if (signature.length !== 64) throw new Error("Unexpected VAPID signature format.")

  return `vapid t=${unsignedToken}.${base64UrlEncode(signature)}, k=${config.publicKey}`
}

export async function encryptWebPushPayload(
  subscription: WebPushSubscription,
  payload: Uint8Array,
): Promise<Uint8Array> {
  validateSubscription(subscription)
  const clientPublicBytes = base64UrlDecode(subscription.p256dh)
  const authSecret = base64UrlDecode(subscription.auth)
  const clientPublicKey = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(clientPublicBytes),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  )
  const serverKeys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  ) as CryptoKeyPair
  const serverPublicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey))
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: clientPublicKey },
    serverKeys.privateKey,
    256,
  ))

  const authPseudoRandomKey = await hkdfExtract(authSecret, sharedSecret)
  const keyInfo = concatBytes(
    encoder.encode("WebPush: info\0"),
    clientPublicBytes,
    serverPublicBytes,
  )
  const inputKeyMaterial = await hkdfExpand(authPseudoRandomKey, keyInfo, 32)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const pseudoRandomKey = await hkdfExtract(salt, inputKeyMaterial)
  const contentEncryptionKey = await hkdfExpand(
    pseudoRandomKey,
    encoder.encode("Content-Encoding: aes128gcm\0"),
    16,
  )
  const nonce = await hkdfExpand(
    pseudoRandomKey,
    encoder.encode("Content-Encoding: nonce\0"),
    12,
  )

  const recordSize = 4096
  const plaintext = concatBytes(payload, Uint8Array.of(2))
  if (plaintext.length + 16 > recordSize) {
    throw new Error("Push payload is too large for a single Web Push record.")
  }
  const aesKey = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(contentEncryptionKey),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  )
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: asArrayBuffer(nonce), tagLength: 128 },
    aesKey,
    asArrayBuffer(plaintext),
  ))

  const header = new Uint8Array(16 + 4 + 1 + serverPublicBytes.length)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, recordSize, false)
  header[20] = serverPublicBytes.length
  header.set(serverPublicBytes, 21)
  return concatBytes(header, ciphertext)
}

export async function buildWebPushRequest(
  subscription: WebPushSubscription,
  payload: unknown,
  vapid: VapidConfig,
): Promise<WebPushRequest> {
  const payloadBytes = encoder.encode(JSON.stringify(payload))
  const body = await encryptWebPushPayload(subscription, payloadBytes)
  const authorization = await createVapidAuthorization(subscription.endpoint, vapid)
  return {
    endpoint: subscription.endpoint,
    headers: {
      "Authorization": authorization,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "86400",
      "Urgency": "normal",
    },
    body,
  }
}

export async function sendWebPush(
  subscription: WebPushSubscription,
  payload: unknown,
  vapid: VapidConfig,
): Promise<Response> {
  const request = await buildWebPushRequest(subscription, payload, vapid)
  return await fetch(request.endpoint, {
    method: "POST",
    headers: request.headers,
    body: asArrayBuffer(request.body),
  })
}
