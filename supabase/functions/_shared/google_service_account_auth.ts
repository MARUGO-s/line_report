const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"

/**
 * モジュールレベルキャッシュ
 * 同一 Edge Function 実行内（background_sync 中）で 220 回トークン取得していたのを 1 回に削減する
 */
let _tokenCache: { token: string; scopeKey: string; expiresAtMs: number } | null = null
let _cryptoKeyCache: { key: CryptoKey; pem: string } | null = null

export async function fetchGoogleServiceAccountAccessToken(
  scopes: string[],
): Promise<string> {
  const nowMs = Date.now()
  const scopeKey = scopes.slice().sort().join(" ")

  // 60秒のバッファを持たせてキャッシュを再利用（同一実行内で最大 1 回だけ取得）
  if (_tokenCache && _tokenCache.scopeKey === scopeKey && _tokenCache.expiresAtMs > nowMs + 60_000) {
    return _tokenCache.token
  }

  const email = (Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL") ?? "").trim()
  const privateKeyPem = (Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY") ?? "").trim()
  if (!email || !privateKeyPem) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is missing.")
  }
  if (scopes.length === 0) {
    throw new Error("At least one OAuth scope is required.")
  }

  const nowSec = Math.floor(nowMs / 1000)
  const header = { alg: "RS256", typ: "JWT" }
  const payload = {
    iss: email,
    scope: scopeKey,
    aud: GOOGLE_TOKEN_URL,
    exp: nowSec + 3600,
    iat: nowSec,
  }

  const unsigned = `${base64UrlEncodeText(JSON.stringify(header))}.${base64UrlEncodeText(JSON.stringify(payload))}`
  const signature = await signRs256(unsigned, privateKeyPem)
  const assertion = `${unsigned}.${signature}`

  const body = new URLSearchParams()
  body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer")
  body.set("assertion", assertion)

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Google OAuth token request failed (${response.status}): ${text}`)
  }

  const json = await response.json()
  const accessToken = String(json?.access_token ?? "")
  if (!accessToken) {
    throw new Error("Google OAuth token response missing access_token.")
  }

  // キャッシュに保存（有効期限 1 時間、実行内で使い回す）
  _tokenCache = { token: accessToken, scopeKey, expiresAtMs: nowMs + 3600_000 }
  return accessToken
}

async function signRs256(data: string, privateKeyPem: string): Promise<string> {
  // CryptoKey のインポートも毎回実行すると重いのでキャッシュする
  let cryptoKey: CryptoKey
  if (_cryptoKeyCache && _cryptoKeyCache.pem === privateKeyPem) {
    cryptoKey = _cryptoKeyCache.key
  } else {
    const keyData = pemToArrayBuffer(privateKeyPem)
    cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      keyData,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    )
    _cryptoKeyCache = { key: cryptoKey, pem: privateKeyPem }
  }
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(data),
  )
  return base64UrlEncodeBytes(new Uint8Array(signature))
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const cleaned = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "")
  const binary = atob(cleaned)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

function base64UrlEncodeText(value: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(value))
}

function base64UrlEncodeBytes(value: Uint8Array): string {
  let binary = ""
  for (const b of value) {
    binary += String.fromCharCode(b)
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}
