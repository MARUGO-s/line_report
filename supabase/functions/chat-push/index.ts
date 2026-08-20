import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import { sendWebPush, type VapidConfig, type WebPushSubscription } from "../_shared/web_push.ts"
import { buildDeclarativeChatPushPayload } from "../_shared/chat_push_payload.ts"

type DbClient = any

function runInBackground(promise: Promise<unknown>): boolean {
  const runtime = (globalThis as typeof globalThis & {
    EdgeRuntime?: { waitUntil(value: Promise<unknown>): void }
  }).EdgeRuntime
  if (!runtime?.waitUntil) return false
  runtime.waitUntil(promise)
  return true
}

type SubscriptionInput = {
  endpoint?: unknown
  expirationTime?: unknown
  keys?: {
    p256dh?: unknown
    auth?: unknown
  }
}

type PushSubscriptionRow = {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth_secret: string
  failure_count: number | null
}

type SubscriptionPreferenceRow = {
  user_id: string
  notifications_enabled: boolean
  preview_enabled: boolean
}

type ChatMessageRow = {
  id: number
  group_id: number
  user_id: string
  username: string
  content: string
  created_at: string
  mentions: string[] | null
  chat_groups: {
    group_name: string
    is_direct: boolean
  } | Array<{
    group_name: string
    is_direct: boolean
  }> | null
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
}

function secureEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a)
  const bb = new TextEncoder().encode(b)
  if (aa.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < aa.length; i += 1) diff |= aa[i] ^ bb[i]
  return diff === 0
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })
}

function bearerToken(req: Request): string {
  return /^Bearer\s+(.+)$/i.exec(String(req.headers.get("authorization") ?? "").trim())?.[1]?.trim() ?? ""
}

function normalizeVapidConfig(value: unknown): VapidConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const publicKey = String(row.public_key ?? row.publicKey ?? "").trim()
  const privateKey = String(row.private_key ?? row.privateKey ?? "").trim()
  const subject = String(row.subject ?? "").trim()
  if (!publicKey || !privateKey || !subject) return null
  return { publicKey, privateKey, subject }
}

async function requireVapidConfig(supabase: DbClient): Promise<VapidConfig> {
  const envConfig = normalizeVapidConfig({
    public_key: Deno.env.get("CHAT_VAPID_PUBLIC_KEY"),
    private_key: Deno.env.get("CHAT_VAPID_PRIVATE_KEY"),
    subject: Deno.env.get("CHAT_VAPID_SUBJECT"),
  })
  if (envConfig) return envConfig

  const { data, error } = await supabase.rpc("chat_get_vapid_config")
  const vaultConfig = normalizeVapidConfig(data)
  if (error || !vaultConfig) {
    console.error("Chat VAPID config load error:", error?.message ?? "missing config")
    throw new Error("Chat push configuration is unavailable.")
  }
  return vaultConfig
}

function validateVapidConfig(config: VapidConfig): VapidConfig {
  const publicKey = config.publicKey
  const privateKey = config.privateKey
  const subject = config.subject
  if (!publicKey || !privateKey || !subject) {
    throw new Error("CHAT_VAPID_PUBLIC_KEY, CHAT_VAPID_PRIVATE_KEY, and CHAT_VAPID_SUBJECT are required.")
  }
  return { publicKey, privateKey, subject }
}

async function authenticatedUser(
  supabaseUrl: string,
  anonKey: string,
  token: string,
): Promise<{ id: string } | null> {
  if (!token || !anonKey) return null
  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await authClient.auth.getUser(token)
  if (error || !data.user) return null
  return { id: data.user.id }
}

async function internalDispatchAuthorized(
  supabase: DbClient,
  token: string,
): Promise<boolean> {
  if (!token) return false
  const { data, error } = await supabase
    .from("chat_push_internal_config")
    .select("dispatch_secret")
    .eq("id", true)
    .maybeSingle()
  if (error || !data?.dispatch_secret) return false
  return secureEqual(token, String(data.dispatch_secret))
}

function parseSubscription(value: unknown): {
  endpoint: string
  p256dh: string
  auth: string
  expirationTime: string | null
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Push subscription is required.")
  }
  const input = value as SubscriptionInput
  const endpoint = String(input.endpoint ?? "").trim()
  const p256dh = String(input.keys?.p256dh ?? "").trim()
  const auth = String(input.keys?.auth ?? "").trim()
  let parsedEndpoint: URL
  try {
    parsedEndpoint = new URL(endpoint)
  } catch {
    throw new Error("Push endpoint is invalid.")
  }
  if (parsedEndpoint.protocol !== "https:") throw new Error("Push endpoint must use HTTPS.")
  if (!p256dh || !auth) throw new Error("Push subscription keys are missing.")

  const expirationMs = input.expirationTime == null ? null : Number(input.expirationTime)
  const expirationTime = Number.isFinite(expirationMs) && Number(expirationMs) > 0
    ? new Date(Number(expirationMs)).toISOString()
    : null
  return { endpoint, p256dh, auth, expirationTime }
}

function messagePreview(content: string): string {
  return String(content ?? "").replace(/\s+/g, " ").trim().slice(0, 120)
}

function notificationUrl(groupId: number): string {
  return `/line_report/chat.html?group=${encodeURIComponent(String(groupId))}`
}

async function loadMessage(
  supabase: DbClient,
  messageId: number,
): Promise<ChatMessageRow | null> {
  const { data, error } = await supabase
    .from("chat_messages")
    .select("id, group_id, user_id, username, content, created_at, mentions, chat_groups(group_name, is_direct)")
    .eq("id", messageId)
    .maybeSingle()
  if (error) throw new Error(`message load failed: ${error.message}`)
  return data as ChatMessageRow | null
}

async function markSubscriptionFailure(
  supabase: DbClient,
  row: PushSubscriptionRow,
  status: number,
  reason: string,
): Promise<void> {
  const expired = status === 404 || status === 410
  await supabase
    .from("chat_push_subscriptions")
    .update({
      is_active: !expired,
      failure_count: (Number(row.failure_count) || 0) + 1,
      updated_at: new Date().toISOString(),
      ...(expired ? { last_seen_at: new Date().toISOString() } : {}),
    })
    .eq("id", row.id)
  console.error("Chat push failed:", { subscription_id: row.id, status, reason: reason.slice(0, 500) })
}

async function handleRegister(
  req: Request,
  supabase: DbClient,
  userId: string,
): Promise<Response> {
  let body: Record<string, unknown>
  try {
    const parsed = await req.json()
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400)
  }

  let subscription
  try {
    subscription = parseSubscription(body.subscription)
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400)
  }

  const previewEnabled = body.preview_enabled !== false
  const activate = body.activate === true
  const now = new Date().toISOString()
  const { error } = await supabase
    .from("chat_push_subscriptions")
    .upsert({
      user_id: userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      auth_secret: subscription.auth,
      expiration_time: subscription.expirationTime,
      user_agent: String(req.headers.get("user-agent") ?? "").slice(0, 1000) || null,
      preview_enabled: previewEnabled,
      is_active: true,
      failure_count: 0,
      last_seen_at: now,
      updated_at: now,
    }, { onConflict: "endpoint" })
  if (error) return json({ ok: false, error: `subscription save failed: ${error.message}` }, 500)

  // iOSでは壊れた購読を作り直すたびendpointが変わるため、同じユーザー・同じ
  // User-Agentの旧購読を停止する。先に新購読を保存し、失敗時に正常購読を失わない。
  const userAgent = String(req.headers.get("user-agent") ?? "").slice(0, 1000) || null
  let cleanupQuery = supabase
    .from("chat_push_subscriptions")
    .update({ is_active: false, updated_at: now })
    .eq("user_id", userId)
    .neq("endpoint", subscription.endpoint)
  cleanupQuery = userAgent === null
    ? cleanupQuery.is("user_agent", null)
    : cleanupQuery.eq("user_agent", userAgent)
  const { error: deactivateError } = await cleanupQuery
  if (deactivateError) {
    return json({ ok: false, error: `old subscription cleanup failed: ${deactivateError.message}` }, 500)
  }

  const preferenceRow = {
    user_id: userId,
    notifications_enabled: true,
    preview_enabled: previewEnabled,
    updated_at: now,
  }
  const preferenceResult = activate
    ? await supabase
      .from("chat_push_user_preferences")
      .upsert(preferenceRow, { onConflict: "user_id" })
    : await supabase
      .from("chat_push_user_preferences")
      .upsert(preferenceRow, { onConflict: "user_id", ignoreDuplicates: true })
  if (preferenceResult.error) {
    return json({ ok: false, error: `notification preference save failed: ${preferenceResult.error.message}` }, 500)
  }
  return json({ ok: true, enabled: true, preview_enabled: previewEnabled }, 200)
}

async function handleTest(
  req: Request,
  supabase: DbClient,
  vapid: VapidConfig,
  userId: string,
): Promise<Response> {
  let body: Record<string, unknown> = {}
  try {
    const parsed = await req.json()
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>
    }
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400)
  }
  const endpoint = String(body.endpoint ?? "").trim()
  if (!endpoint) return json({ ok: false, error: "endpoint is required." }, 400)
  const requestedTestId = String(body.test_id ?? "").trim()
  const testId = requestedTestId || crypto.randomUUID()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(testId)) {
    return json({ ok: false, error: "test_id is invalid." }, 400)
  }
  const requestedDelay = Number(body.delay_ms)
  const delayMs = Number.isFinite(requestedDelay)
    ? Math.max(0, Math.min(5000, Math.trunc(requestedDelay)))
    : 0
  const clientState = body.client_state && typeof body.client_state === "object" && !Array.isArray(body.client_state)
    ? body.client_state as Record<string, unknown>
    : {}

  const { data, error } = await supabase
    .from("chat_push_subscriptions")
    .select("id, user_id, endpoint, p256dh, auth_secret, failure_count")
    .eq("user_id", userId)
    .eq("endpoint", endpoint)
    .eq("is_active", true)
    .maybeSingle()
  if (error) return json({ ok: false, error: `subscription load failed: ${error.message}` }, 500)
  const row = data as PushSubscriptionRow | null
  if (!row) return json({ ok: false, error: "Active subscription not found." }, 404)

  const safeClientState = {
    permission: String(clientState.permission ?? "").slice(0, 20),
    standalone: clientState.standalone === true,
    controller: clientState.controller === true,
    visibility: String(clientState.visibility ?? "").slice(0, 20),
    push_manager: clientState.push_manager === true,
  }
  const { error: queueError } = await supabase.from("chat_push_delivery_diagnostics").insert({
    test_id: testId,
    user_id: userId,
    subscription_id: row.id,
    stage: "server_queued",
    detail: JSON.stringify(safeClientState).slice(0, 500),
  })
  if (queueError) {
    return json({ ok: false, error: `diagnostic queue failed: ${queueError.message}` }, 500)
  }

  const sendPromise = (async () => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    const pushSubscription: WebPushSubscription = {
      endpoint: row.endpoint,
      p256dh: row.p256dh,
      auth: row.auth_secret,
    }
    try {
      const response = await sendWebPush(
        pushSubscription,
        buildDeclarativeChatPushPayload({
          title: "M-talk 通知テスト",
          body: "この通知が見えれば、この端末の新着通知は正常です。",
          navigatePath: "/line_report/chat.html",
          testId,
          tag: `chat-push-test-${testId}`,
        }),
        vapid,
      )
      if (!response.ok) {
        const reason = await response.text().catch(() => "")
        await supabase.from("chat_push_delivery_diagnostics").upsert({
          test_id: testId,
          user_id: userId,
          subscription_id: row.id,
          stage: "server_failed",
          detail: `push_http_${response.status}:${reason}`.slice(0, 500),
        }, { onConflict: "test_id,stage" })
        await markSubscriptionFailure(supabase, row, response.status, reason)
        return
      }
      await supabase.from("chat_push_subscriptions").update({
        failure_count: 0,
        is_active: true,
        last_success_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", row.id)
      await supabase.from("chat_push_delivery_diagnostics").upsert({
        test_id: testId,
        user_id: userId,
        subscription_id: row.id,
        stage: "server_sent",
        detail: `push_http_${response.status}`,
      }, { onConflict: "test_id,stage" })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await supabase.from("chat_push_delivery_diagnostics").upsert({
        test_id: testId,
        user_id: userId,
        subscription_id: row.id,
        stage: "server_failed",
        detail: reason.slice(0, 500),
      }, { onConflict: "test_id,stage" })
      await markSubscriptionFailure(supabase, row, 0, reason)
    }
  })()
  if (runInBackground(sendPromise)) {
    return json({ ok: true, queued: true, sent: 0, failed: 0, test_id: testId }, 202)
  }
  await sendPromise
  return json({ ok: true, queued: false, sent: 0, failed: 0, test_id: testId }, 200)
}

async function handleDiagnostic(
  req: Request,
  supabase: DbClient,
  userId: string,
): Promise<Response> {
  let body: Record<string, unknown> = {}
  try {
    const parsed = await req.json()
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>
    }
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400)
  }
  const testId = String(body.test_id ?? "").trim()
  const stage = String(body.stage ?? "").trim()
  const detail = String(body.detail ?? "").trim().slice(0, 500) || null
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(testId)) {
    return json({ ok: false, error: "test_id is invalid." }, 400)
  }
  if (!["sw_received", "notification_shown", "notification_failed"].includes(stage)) {
    return json({ ok: false, error: "stage is invalid." }, 400)
  }
  const { data: sentRow, error: sentError } = await supabase
    .from("chat_push_delivery_diagnostics")
    .select("subscription_id")
    .eq("test_id", testId)
    .eq("user_id", userId)
    .eq("stage", "server_queued")
    .maybeSingle()
  if (sentError || !sentRow) return json({ ok: false, error: "Unknown push test." }, 404)

  const { error } = await supabase.from("chat_push_delivery_diagnostics").upsert({
      test_id: testId,
      user_id: userId,
      subscription_id: sentRow.subscription_id,
      stage,
      detail,
    }, { onConflict: "test_id,stage" })
  if (error) return json({ ok: false, error: `diagnostic save failed: ${error.message}` }, 500)
  return json({ ok: true }, 200)
}

async function handleDiagnosticStatus(
  req: Request,
  supabase: DbClient,
  userId: string,
): Promise<Response> {
  let body: Record<string, unknown> = {}
  try {
    const parsed = await req.json()
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>
    }
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400)
  }
  const testId = String(body.test_id ?? "").trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(testId)) {
    return json({ ok: false, error: "test_id is invalid." }, 400)
  }
  const { data, error } = await supabase
    .from("chat_push_delivery_diagnostics")
    .select("stage, detail, created_at")
    .eq("test_id", testId)
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
  if (error) return json({ ok: false, error: `diagnostic load failed: ${error.message}` }, 500)
  return json({ ok: true, test_id: testId, events: data || [] }, 200)
}

async function handleUnregister(
  req: Request,
  supabase: DbClient,
  userId: string,
): Promise<Response> {
  let endpoint = ""
  try {
    const body = await req.json()
    endpoint = String(body?.endpoint ?? "").trim()
  } catch {
    // endpoint無しは、このユーザーの全端末を停止する操作として扱う。
  }
  let query = supabase
    .from("chat_push_subscriptions")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
  if (endpoint) query = query.eq("endpoint", endpoint)
  const { error } = await query
  if (error) return json({ ok: false, error: `subscription disable failed: ${error.message}` }, 500)
  return json({ ok: true, enabled: false }, 200)
}

async function handlePreferenceSync(
  req: Request,
  supabase: DbClient,
  userId: string,
): Promise<Response> {
  let body: Record<string, unknown> = {}
  try {
    const parsed = await req.json()
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>
    }
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400)
  }
  const patch: Record<string, unknown> = { user_id: userId, updated_at: new Date().toISOString() }
  if (typeof body.notifications_enabled === "boolean") {
    patch.notifications_enabled = body.notifications_enabled
  }
  if (typeof body.preview_enabled === "boolean") {
    patch.preview_enabled = body.preview_enabled
  }
  if ("notifications_enabled" in patch || "preview_enabled" in patch) {
    const { error: updateError } = await supabase
      .from("chat_push_user_preferences")
      .upsert(patch, { onConflict: "user_id" })
    if (updateError) return json({ ok: false, error: `preference update failed: ${updateError.message}` }, 500)
  }

  const { data, error } = await supabase
    .from("chat_push_user_preferences")
    .select("user_id, notifications_enabled, preview_enabled")
    .eq("user_id", userId)
    .maybeSingle()
  if (error) return json({ ok: false, error: `preference load failed: ${error.message}` }, 500)
  const row = data as SubscriptionPreferenceRow | null
  if (!row) return json({ ok: true, found: false }, 200)
  return json({
    ok: true,
    found: true,
    notifications_enabled: row.notifications_enabled === true,
    preview_enabled: row.preview_enabled !== false,
  }, 200)
}

async function handleDispatch(
  req: Request,
  supabase: DbClient,
  vapid: VapidConfig,
  actorUserId: string | null,
): Promise<Response> {
  let body: Record<string, unknown> = {}
  try {
    const parsed = await req.json()
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>
    }
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400)
  }
  const messageId = Number(body.message_id)
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    return json({ ok: false, error: "message_id must be a positive integer." }, 400)
  }

  const message = await loadMessage(supabase, messageId)
  if (!message) return json({ ok: false, error: "Message not found." }, 404)
  if (actorUserId && message.user_id !== actorUserId) {
    return json({ ok: false, error: "Only the message sender can dispatch its notification." }, 403)
  }

  const { data: claimed, error: claimError } = await supabase.rpc(
    "chat_claim_push_dispatch",
    { p_message_id: messageId },
  )
  if (claimError) return json({ ok: false, error: `dispatch claim failed: ${claimError.message}` }, 500)
  if (claimed !== true) return json({ ok: true, duplicate: true, message_id: messageId }, 200)

  const { data: memberRows, error: memberError } = await supabase
    .from("chat_group_members")
    .select("user_id, muted_at")
    .eq("group_id", message.group_id)
    .neq("user_id", message.user_id)
  if (memberError) throw new Error(`member load failed: ${memberError.message}`)
  const recipientIds: string[] = [...new Set<string>(
    (memberRows || [])
      .filter((row: { muted_at?: unknown }) => !row.muted_at)
      .map((row: { user_id?: unknown }) => String(row.user_id ?? "").trim())
      .filter(Boolean),
  )]
  if (!recipientIds.length) {
    await supabase.from("chat_push_dispatches").update({
      completed_at: new Date().toISOString(),
      sent_count: 0,
      failure_count: 0,
      last_error: null,
    }).eq("message_id", messageId)
    return json({ ok: true, message_id: messageId, sent: 0, failed: 0 }, 200)
  }

  const { data: preferenceRows, error: preferencesError } = await supabase
    .from("chat_push_user_preferences")
    .select("user_id, notifications_enabled, preview_enabled")
    .in("user_id", recipientIds)
    .eq("notifications_enabled", true)
  if (preferencesError) throw new Error(`preference load failed: ${preferencesError.message}`)
  const preferences = new Map<string, SubscriptionPreferenceRow>()
  for (const row of (preferenceRows || []) as SubscriptionPreferenceRow[]) {
    preferences.set(row.user_id, row)
  }
  const enabledRecipientIds = recipientIds.filter((id) => preferences.has(id))
  if (!enabledRecipientIds.length) {
    await supabase.from("chat_push_dispatches").update({
      completed_at: new Date().toISOString(),
      sent_count: 0,
      failure_count: 0,
      last_error: null,
    }).eq("message_id", messageId)
    return json({ ok: true, message_id: messageId, sent: 0, failed: 0 }, 200)
  }

  const { data: subscriptionRows, error: subscriptionsError } = await supabase
    .from("chat_push_subscriptions")
    .select("id, user_id, endpoint, p256dh, auth_secret, failure_count")
    .in("user_id", enabledRecipientIds)
    .eq("is_active", true)
  if (subscriptionsError) throw new Error(`subscription load failed: ${subscriptionsError.message}`)

  const subscriptions = (subscriptionRows || []) as PushSubscriptionRow[]
  const unreadTotals = new Map<string, number>()
  const subscribedRecipientIds = [...new Set(subscriptions.map((row) => row.user_id))]
  if (subscribedRecipientIds.length) {
    const { data: unreadRows, error: unreadError } = await supabase.rpc(
      "chat_push_unread_totals",
      { p_user_ids: subscribedRecipientIds },
    )
    if (unreadError) {
      // バッジ件数の取得失敗でWeb Push本体を止めない。
      console.error("Chat push unread total error:", unreadError.message)
    } else {
      for (const row of (unreadRows || []) as Array<{ user_id?: unknown; unread_count?: unknown }>) {
        const userId = String(row.user_id ?? "").trim()
        const count = Number(row.unread_count)
        if (userId && Number.isSafeInteger(count) && count >= 0) {
          unreadTotals.set(userId, count)
        }
      }
    }
  }

  const group = Array.isArray(message.chat_groups)
    ? (message.chat_groups[0] ?? null)
    : message.chat_groups
  let sent = 0
  let failed = 0
  const errors: string[] = []
  for (const row of subscriptions) {
    const preference = preferences.get(row.user_id)
    const preview = preference?.preview_enabled !== false
      ? messagePreview(message.content)
      : "新しいメッセージがあります"
    const title = group?.is_direct
      ? String(message.username || "M-talk")
      : String(group?.group_name || "M-talk")
    // 名指しされた人には、通知本文の頭でそれと分かるようにする。
    const mentioned = Array.isArray(message.mentions) && message.mentions.includes(row.user_id)
    const mentionPrefix = mentioned ? "@あなた宛 " : ""
    const pushSubscription: WebPushSubscription = {
      endpoint: row.endpoint,
      p256dh: row.p256dh,
      auth: row.auth_secret,
    }
    try {
      const response = await sendWebPush(
        pushSubscription,
        buildDeclarativeChatPushPayload({
          title,
          body: group?.is_direct
            ? `${mentionPrefix}${preview}`
            : `${mentionPrefix}${message.username}: ${preview}`,
          navigatePath: notificationUrl(message.group_id),
          tag: `chat-group-${message.group_id}`,
          groupId: message.group_id,
          messageId: message.id,
          badgeCount: unreadTotals.get(row.user_id) ?? null,
        }),
        vapid,
      )
      if (response.ok) {
        sent += 1
        await supabase.from("chat_push_subscriptions").update({
          failure_count: 0,
          is_active: true,
          last_success_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", row.id)
      } else {
        failed += 1
        const reason = await response.text().catch(() => "")
        errors.push(`${row.id}: HTTP ${response.status}`)
        await markSubscriptionFailure(supabase, row, response.status, reason)
      }
    } catch (error) {
      failed += 1
      const reason = error instanceof Error ? error.message : String(error)
      errors.push(`${row.id}: ${reason}`)
      await markSubscriptionFailure(supabase, row, 0, reason)
    }
  }

  await supabase.from("chat_push_dispatches").update({
    completed_at: new Date().toISOString(),
    sent_count: sent,
    failure_count: failed,
    last_error: errors.length ? errors.join("; ").slice(0, 4000) : null,
  }).eq("message_id", messageId)
  return json({
    ok: true,
    message_id: messageId,
    recipients: recipientIds.length,
    subscriptions: subscriptions.length,
    sent,
    failed,
  }, 200)
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS })

  const supabaseUrl = String(Deno.env.get("SUPABASE_URL") ?? "").trim()
  const serviceRoleKey = String(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim()
  const anonKey = String(Deno.env.get("SUPABASE_ANON_KEY") ?? "").trim()
  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    return json({ ok: false, error: "Supabase server configuration is missing." }, 500)
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as DbClient
  let vapid: VapidConfig
  try {
    vapid = validateVapidConfig(await requireVapidConfig(supabase))
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 503)
  }

  const url = new URL(req.url)
  const action = String(url.searchParams.get("action") ?? "").trim().toLowerCase()
  if (req.method === "GET" && action === "config") {
    return json({ ok: true, public_key: vapid.publicKey }, 200)
  }

  const token = bearerToken(req)
  const user = await authenticatedUser(supabaseUrl, anonKey, token)
  if (user) {
    if (req.method === "POST" && action === "subscribe") {
      return await handleRegister(req, supabase, user.id)
    }
    if (req.method === "DELETE" && action === "subscribe") {
      return await handleUnregister(req, supabase, user.id)
    }
    if (req.method === "POST" && action === "preferences") {
      return await handlePreferenceSync(req, supabase, user.id)
    }
    if (req.method === "POST" && action === "test") {
      return await handleTest(req, supabase, vapid, user.id)
    }
    if (req.method === "POST" && action === "diagnostic") {
      return await handleDiagnostic(req, supabase, user.id)
    }
    if (req.method === "POST" && action === "diagnostic-status") {
      return await handleDiagnosticStatus(req, supabase, user.id)
    }
    if (req.method === "POST" && action === "dispatch") {
      try {
        return await handleDispatch(req, supabase, vapid, user.id)
      } catch (error) {
        console.error("Chat push dispatch error:", error)
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
      }
    }
    return json({ ok: false, error: "Not found." }, 404)
  }
  if (
    req.method === "POST" &&
    action === "dispatch" &&
    await internalDispatchAuthorized(supabase, token)
  ) {
    try {
      return await handleDispatch(req, supabase, vapid, null)
    } catch (error) {
      console.error("Chat push dispatch error:", error)
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  }
  return json({ ok: false, error: "Unauthorized." }, 401)
})
