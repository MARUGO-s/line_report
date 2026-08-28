import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const root = new URL("..", import.meta.url)
const read = (path) => readFile(new URL(path, root), "utf8")

test("every owned verify_jwt=false cron authorizes before privileged work", async () => {
  const cronNames = [
    "calendar-tomorrow-cron", "foodcourt-forecast-cron", "pv-japan-alert-cron",
    "review-alert-cron", "reservation-today-cron", "tokyo-dome-events-cron",
    "tokyo-dome-weekly-cron", "weather-daily-cron", "receipt-midreport-cron",
    "gmail-alert-cron", "reservation-ai-cache-cron",
  ]
  for (const name of cronNames) {
    const source = await read(`supabase/functions/${name}/index.ts`)
    assert.match(source, /isInternalCronAuthorized/)
    assert.match(source, /if \(!\(await isInternalCronAuthorized\(req, supabase\)\)\)[\s\S]{0,140}(?:401|Unauthorized|unauthorized)/)
  }
  const migration = await read("supabase/migrations/20260910040000_security_authorization_hardening.sql")
  const resolver = migration.slice(
    migration.indexOf("create or replace function public.resolve_edge_cron_auth_token"),
    migration.indexOf("alter table public.chat_user_access"),
  )
  assert.match(resolver, /where name = 'CRON_AUTH_TOKEN'/)
  assert.doesNotMatch(resolver, /where name = 'SUPABASE_ANON_KEY'/)
  assert.match(resolver, /revoke all[\s\S]*from public, anon, authenticated/)
})

test("test-send and retention secrets never rely on URL values or direct comparison", async () => {
  const [reservation, dome, receipt, retention] = await Promise.all([
    read("supabase/functions/reservation-today-cron/index.ts"),
    read("supabase/functions/tokyo-dome-weekly-cron/index.ts"),
    read("supabase/functions/receipt-midreport-cron/index.ts"),
    read("supabase/functions/room-messages-retention-cron/index.ts"),
  ])
  for (const source of [reservation, dome, receipt]) {
    assert.doesNotMatch(source, /searchParams\.get\(["']key["']\)/)
  }
  assert.match(reservation, /constantTimeEqualSecret\(provided, testKey\)/)
  assert.match(dome, /constantTimeEqualSecret\(provided, testKey\)/)
  assert.match(receipt, /constantTimeEqual\(provided, testKey\)/)
  assert.match(retention, /constantTimeEqual\(headerKey, secret\)/)
  assert.match(retention, /constantTimeEqual\(bearer, serviceKey\)/)
  assert.doesNotMatch(retention, /headerKey === secret|auth === `Bearer/)
})

test("receipt sheets authorization never infers service role from a database error", async () => {
  const source = await read("supabase/functions/receipt-sheets-sync-cron/index.ts")
  const auth = source.slice(source.indexOf("function bearerToken"), source.indexOf("function json("))
  assert.match(auth, /constantTimeEqual\(bearer, sr\)/)
  assert.match(auth, /isInternalCronAuthorized\(req, supabase\)/)
  assert.doesNotMatch(auth, /createClient\(supabaseUrl, bearer\)/)
  assert.doesNotMatch(auth, /Invalid API key|PGRST301/)
  assert.doesNotMatch(source, /\(await isServiceRoleAuthorized\(req\)\) \|\|/)
})

test("LINE webhooks fail closed and verify HMAC without direct string comparison", async () => {
  const [line, admin] = await Promise.all([
    read("supabase/functions/line-webhook/index.ts"),
    read("supabase/functions/_shared/line_admin_webhook.ts"),
  ])
  for (const source of [line, admin]) {
    const signatureStart = source.indexOf("async function verifyLineSignature")
    const signature = source.slice(signatureStart, source.indexOf("\nfunction ", signatureStart + 1))
    assert.match(signature, /if \(!channelSecret\) return false/)
    assert.match(signature, /crypto\.subtle\.verify\('HMAC'/)
    assert.doesNotMatch(signature, /hashBase64 === signatureHeader/)
  }
})

test("login links are endpoint-bound and every store link has an explicit purpose", async () => {
  const [auth, api] = await Promise.all([
    read("supabase/functions/_shared/admin_dashboard_link_auth.ts"),
    read("supabase/functions/admin-api/index.ts"),
  ])
  for (const scope of [
    "RESERVATION_CALENDAR_SCOPE", "PETTY_CASH_SCOPE", "RECEIPT_ANALYTICS_SCOPE",
    "FOODCOURT_DASHBOARD_SCOPE", "FOODCOURT_DAILY_LOG_SCOPE",
    "FOODCOURT_WEEKLY_VIEW_SCOPE", "CHAT_JOURNAL_AI_SCOPE",
  ]) assert.match(auth, new RegExp(`export const ${scope}`))

  assert.match(auth, /requiredScopes[\s\S]*cannot be used on this endpoint/)
  assert.match(auth, /Exchange-time metadata[\s\S]*\.\.\.existingMeta[\s\S]*exchanged_at/)
  assert.match(api, /requiredScopes: GENERIC_LINK_LOGIN_SCOPES/)
  assert.match(api, /requiredScopes: \[CHAT_JOURNAL_AI_SCOPE\]/)
  assert.match(api, /requiredScopes: \[CHAT_MEDIA_VIEW_SCOPE\]/)
  assert.match(api, /session\.storeScope && session\.scopeKind === null[\s\S]*旧形式の店舗リンクは無効/)
  const genericScopes = api.slice(
    api.indexOf("const GENERIC_LINK_LOGIN_SCOPES"),
    api.indexOf("async function resolveFoodCourtPassingAwareCacheVersion"),
  )
  assert.doesNotMatch(genericScopes, /ROOM_CONFIG_SCOPE|CHAT_MEDIA_VIEW_SCOPE/)

  const issuers = [
    ["supabase/functions/_shared/foodcourt_compare.ts", "FOODCOURT_DASHBOARD_SCOPE"],
    ["supabase/functions/_shared/petty_cash_flow.ts", "PETTY_CASH_SCOPE"],
    ["supabase/functions/_shared/reservation_calendar_link_request.ts", "RESERVATION_CALENDAR_SCOPE"],
    ["supabase/functions/_shared/budget_entry_flow.ts", "RECEIPT_ANALYTICS_SCOPE"],
    ["supabase/functions/reservation-today-cron/index.ts", "RESERVATION_CALENDAR_SCOPE"],
    ["supabase/functions/gmail-alert-cron/index.ts", "RESERVATION_CALENDAR_SCOPE"],
  ]
  for (const [file, scope] of issuers) assert.match(await read(file), new RegExp(`scope: ${scope}`))
})

test("store link method matrix keeps staff links out of administrator mutations", async () => {
  const api = await read("supabase/functions/admin-api/index.ts")
  const matrix = api.slice(
    api.indexOf("const STORE_LINK_ALLOWED_REQUESTS"),
    api.indexOf("function isStoreLinkRequestAllowed"),
  )
  assert.match(matrix, /GET \/reservations\/calendar/)
  assert.doesNotMatch(matrix, /(?:POST|PUT|PATCH|DELETE) \/reservations\/event/)
  assert.doesNotMatch(matrix, /(?:POST|PUT|PATCH|DELETE) \/petty-cash(?:"|\/)/)
  assert.doesNotMatch(matrix, /GET \/receipts\/daily-receipts/)
  assert.doesNotMatch(matrix, /DELETE \/foodcourt\/daily-logs/)
  assert.doesNotMatch(matrix, /foodcourt\/events\/attendance|foodcourt\/dome-weekly/)
  assert.doesNotMatch(matrix, /GET \/foodcourt\/ai-fallback-events/)
  assert.match(matrix, /\[FOODCOURT_WEEKLY_VIEW_SCOPE\][\s\S]*GET \/foodcourt\/weekly-report/)
  assert.match(api, /!isStoreLinkRequestAllowed\(authResult\.scopeKind, req\.method, path\)[\s\S]*403/)
})

test("cron credentials are endpoint-bound and rate-limit failures deny requests", async () => {
  const [api, ai] = await Promise.all([
    read("supabase/functions/admin-api/index.ts"),
    read("supabase/functions/ai-analyze/index.ts"),
  ])
  const cronMatrix = api.slice(
    api.indexOf("const CRON_ALLOWED_REQUESTS"),
    api.indexOf("function isStoreLinkRequestAllowed"),
  )
  assert.match(cronMatrix, /POST \/reservations\/ai-cache\/rebuild/)
  assert.match(cronMatrix, /POST \/foodcourt\/weekly-report/)
  assert.doesNotMatch(cronMatrix, /chat-admin|documents|receipts|petty-cash/)
  assert.match(api, /authResult\.scopeKind === "cron"[\s\S]{0,220}!CRON_ALLOWED_REQUESTS\.has[\s\S]{0,220}403/)
  const verifyRoute = api.slice(api.indexOf('path === "/auth/verify"'), api.indexOf('path === "/auth/session"'))
  assert.match(verifyRoute, /authResult\.scopeKind === "cron"[\s\S]{0,180}403/)
  assert.match(api, /!rateLimitResult\.available[\s\S]{0,220}rate_limit_unavailable[\s\S]{0,120}503/)
  const limiter = api.slice(api.indexOf("async function consumeRateLimitFromDb"), api.indexOf("function getOfficeXmlEntries"))
  assert.doesNotMatch(limiter, /return \{ allowed: true/)
  assert.match(limiter, /available: false, allowed: false/)
  const aiLimiter = ai.slice(ai.indexOf("async function consumeAiRateLimit"), ai.indexOf("function contentsToOpenAiMessages"))
  assert.match(aiLimiter, /typeof row\.allowed !== "boolean"[\s\S]*allowed: false/)
  assert.doesNotMatch(aiLimiter, /allowed: row\?\.allowed !== false/)
})

test("purpose-limited pages request the exact scope and hide administrator controls", async () => {
  const pages = await Promise.all([
    read("public/reservation.html"),
    read("public/petty_cash.html"),
    read("public/analytics.html"),
    read("public/foodcourt.html"),
    read("public/foodcourt-report.html"),
    read("public/foodcourt-weekly-report.html"),
  ])
  const expectedScopes = [
    "reservation_calendar", "petty_cash", "receipt_analytics",
    "foodcourt_dashboard", "foodcourt_daily_log", "foodcourt_weekly_view",
  ]
  pages.forEach((page, index) => assert.match(page, new RegExp(`targetScopeKind:\\s*['\"]${expectedScopes[index]}['\"]`)))

  const [reservation, petty, analytics, foodcourt, dailyLog] = pages
  assert.match(reservation, /resvEditBtn\.hidden = isLineScopedReservationView\(\)/)
  assert.match(petty, /body\.line-locked \.card\.entry[\s\S]{0,220}\[data-edit\][\s\S]{0,220}\[data-del\]/)
  assert.match(analytics, /body\[data-entry="line"\] \.budget-row[\s\S]{0,120}#manualImportZone/)
  assert.match(analytics, /if \(isLineEntryAnalytics\(\) \|\| !dateKey/)
  assert.match(foodcourt, /html\[data-entry="line"\] \.ms-side/)
  assert.match(foodcourt, /html\[data-entry="line"\] #fallbackAdminCard/)
  assert.match(foodcourt, /isLineScopedFoodcourtView\(\) \? '' : '<div class="qa-archive-actions">/)
  assert.match(foodcourt, /unacked && !isLineScopedFoodcourtView\(\)/)
  assert.match(foodcourt, /const attHtml=isLineScopedFoodcourtView\(\)[\s\S]{0,220}ld-att-readonly/)
  assert.match(dailyLog, /deleteBtn'\)\.style\.display = existing && !isLineScopedDailyLogView\(\)/)
  assert.match(dailyLog, /deleteBtn'\)\.addEventListener\('click',[\s\S]{0,100}if \(isLineScopedDailyLogView\(\)\) return/)
})

test("dynamic chat values are not interpolated into inline JavaScript strings", async () => {
  const [composer, rooms] = await Promise.all([
    read("public/chat/composer.js"),
    read("public/chat/rooms.js"),
  ])
  assert.doesNotMatch(composer, /storagePath:'\$\{escapeHtml\(/)
  assert.doesNotMatch(composer, /openImageViewer\('\$\{escapeHtml\(/)
  assert.match(composer, /storagePath:this\.dataset\.storagePath/)
  assert.doesNotMatch(rooms, /choosePresetIcon\('\$\{escapeHtml\(/)
  assert.match(rooms, /choosePresetIcon\(this\.dataset\.iconPath\)/)
})

test("M-talk never persists a plaintext password in browser storage", async () => {
  const [auth, composer, chat] = await Promise.all([
    read("public/chat/auth.js"),
    read("public/chat/composer.js"),
    read("public/chat.html"),
  ])
  assert.match(auth, /JSON\.stringify\(\{ email: safeEmail \}\)/)
  assert.match(auth, /hasOwnProperty\.call\(saved, 'password'\)[\s\S]*JSON\.stringify\(\{ email \}\)/)
  assert.doesNotMatch(auth, /JSON\.stringify\(\{ email, password \}\)/)
  assert.doesNotMatch(composer, /saved\.password/)
  assert.match(chat, /メールアドレスだけ保存する/)
  assert.doesNotMatch(chat, /メールとパスワードを保存する/)
})

test("M-talk browser surfaces restrict outbound content and reject uploaded SVG icons", async () => {
  const [chat, journalBridge, journal, rooms] = await Promise.all([
    read("public/chat.html"),
    read("public/mtalk_journal_ai.html"),
    read("public/jnm/jnl2txt.html"),
    read("public/chat/rooms.js"),
  ])
  for (const page of [chat, journalBridge, journal]) {
    assert.match(page, /<meta name="referrer" content="no-referrer">/)
    assert.match(page, /Content-Security-Policy/)
    assert.match(page, /object-src 'none'/)
    assert.match(page, /base-uri 'self'/)
  }
  assert.match(chat, /connect-src 'self' https:\/\/hocbnifuactbvmyjraxy\.supabase\.co wss:\/\/hocbnifuactbvmyjraxy\.supabase\.co/)
  assert.match(chat, /img-src 'self' data: blob: https:\/\/hocbnifuactbvmyjraxy\.supabase\.co/)
  assert.match(chat, /script-src-elem 'self'/)
  assert.match(chat, /script-src-attr 'unsafe-inline'/)
  assert.doesNotMatch(chat, /accept="[^"]*(?:image\/svg\+xml|\.svg)/)
  assert.match(rooms, /type === 'image\/svg\+xml' \|\| name\.endsWith\('\.svg'\)/)
  assert.doesNotMatch(rooms, /svg\\\+xml|jpe\?g\|png\|webp\|gif\|svg/)
  assert.doesNotMatch(rooms, /GIF \/ SVG/)
})

test("admin pages never persist a raw headquarters token", async () => {
  const authSession = await read("public/auth-session.js")
  const pages = await Promise.all([
    "analytics.html", "reviews.html", "petty_cash.html", "foodcourt.html",
    "reservation.html", "media.html", "message-search.html", "index.html",
    "ai-usage.html",
  ].map((name) => read(`public/${name}`)))
  assert.match(authSession, /生の固定トークンは永続化しない/)
  assert.match(authSession, /isSessionToken\(token\)/)
  for (const page of pages) {
    assert.doesNotMatch(page, /localStorage\.(?:setItem|getItem)\((?:TOKEN_KEY|STORE_TOKEN_KEY)/)
  }
  assert.match(pages.join("\n"), /安全なログイン機能を読み込めませんでした/)
})

test("M-talk Journal AI is explicit, store-scoped, short-lived, and data-minimized", async () => {
  const [api, ai, migration, admin, core, rooms, journal, scopedAuth, roomSettings, knowledge] = await Promise.all([
    read("supabase/functions/admin-api/index.ts"), read("supabase/functions/ai-analyze/index.ts"),
    read("supabase/migrations/20260910040000_security_authorization_hardening.sql"),
    read("public/chat-admin.html"), read("public/chat/core.js"),
    read("public/chat/rooms.js"), read("public/jnm/jnl2txt.html"),
    read("supabase/functions/_shared/admin_dashboard_link_auth.ts"),
    read("supabase/functions/_shared/mtalk_room_settings.ts"),
    read("supabase/functions/chat-knowledge/index.ts"),
  ])
  assert.match(migration, /can_use_journal_ai boolean not null default false/)
  assert.match(migration, /revoke all on function public\.chat_admin_update_user_access_secure[\s\S]*from public, anon, authenticated/)
  assert.match(api, /capability: "view" \| "send" \| "manage" \| "journal_ai"/)
  assert.match(api, /capability === "journal_ai" && access\.can_use_journal_ai !== true/)
  assert.match(api, /authenticateChatMember\(req, supabase, groupId, "journal_ai"\)/)
  assert.match(api, /validateChatScopedSessionAccess[\s\S]*requireJournalAi: true/)
  assert.match(api, /requireMtalkStoreAccess\(supabase, userId, resolved\.storeKey\)/)
  assert.match(api, /requireMtalkRoomStoreBinding\(supabase, userId, groupId, room\.storeKey\)/)
  assert.match(api, /currentRoomStore\.ambiguous \|\| currentRoomStore\.storeKey !== key/)
  assert.match(scopedAuth, /mtalkUserCanAccessStore\(supabase, chatUserId, storeKey\)/)
  assert.match(scopedAuth, /currentRoomStore\.storeKey !== storeKey/)
  assert.match(roomSettings, /from\("chat_user_stores"\)[\s\S]*\.eq\("user_id", uid\)[\s\S]*\.eq\("store_key", key\)/)
  assert.match(roomSettings, /signup_status === "approved"/)
  assert.match(knowledge, /mtalkUserCanAccessStore\(supabase, String\(message\.user_id/)
  assert.match(knowledge, /reason: "store access revoked"/)
  assert.match(api, /scope: CHAT_JOURNAL_AI_SCOPE/)
  assert.match(api, /ttlSeconds: 30 \* 60/)
  assert.match(ai, /scopeKind !== null && authResult\.scopeKind !== CHAT_JOURNAL_AI_SCOPE/)
  assert.match(ai, /validateChatScopedSessionAccess[\s\S]*requireJournalAi: true/)
  assert.match(admin, /editCanUseJournalAi/)
  assert.match(core, /can_use_journal_ai/)
  assert.match(rooms, /chatAccessAllows\('can_use_journal_ai'\)/)
  assert.match(journal, /MTALK_EMBED \? '\/auth\/chat-journal-link-login' : '\/auth\/link-login'/)
  assert.match(journal, /if \(MTALK_EMBED\) throw new Error\('M-talk埋め込みでは予約データを利用できません'\)/)
  assert.match(journal, /if \(MTALK_EMBED\) return \{ status: 'no-session', items: \[\] \}/)
  assert.match(journal, /if \(!MTALK_EMBED\)[\s\S]{0,180}PDFにする/)
})

test("ordinary room managers cannot approve global signup or store access", async () => {
  const [migration, api, admin, core, permissions, attachments] = await Promise.all([
    read("supabase/migrations/20260910040000_security_authorization_hardening.sql"),
    read("supabase/functions/admin-api/index.ts"), read("public/chat-admin.html"),
    read("public/chat/core.js"), read("public/chat/permissions.js"),
    read("public/chat/attachments.js"),
  ])
  assert.match(migration, /can_review_access boolean not null default false/)
  const manager = migration.slice(
    migration.indexOf("create or replace function public.chat_is_signup_manager"),
    migration.indexOf("create or replace function public.chat_can_see_admin_notice"),
  )
  assert.match(manager, /a\.can_review_access = true/)
  assert.doesNotMatch(manager, /chat_group_members|can_manage/)
  const notices = migration.slice(
    migration.indexOf("create or replace function public.chat_can_see_admin_notice"),
    migration.indexOf("create or replace function public.chat_ensure_manager_notice_room"),
  )
  assert.match(notices, /public\.chat_is_signup_manager\(p_user_id\)/)
  assert.match(notices, /p_user_id = auth\.uid\(\)/)
  assert.match(migration, /select v_id, u\.id, true, true, false, false[\s\S]*chat_is_signup_manager\(u\.id\)/)
  assert.match(migration, /if p_can_review_access is not null then[\s\S]*chat_ensure_manager_notice_room\(\)/)
  assert.match(api, /updateSensitiveAccess = updateJournalAi \|\| updateReviewAccess/)
  assert.match(api, /!authority\.isFullAdmin[\s\S]{0,180}本部管理者だけ/)
  assert.match(admin, /editCanReviewAccess/)
  assert.match(core, /can_review_access/)
  assert.match(permissions, /return chatAccessAllows\('can_review_access'\)/)
  assert.doesNotMatch(permissions, /function currentUserIsSignupManager\(\)[\s\S]{0,180}canCurrentUserManage/)
  const signupReview = attachments.slice(
    attachments.indexOf("async function reviewSignupFromCard"),
    attachments.indexOf("async function reviewStoreChangeFromCard"),
  )
  const storeReview = attachments.slice(
    attachments.indexOf("async function reviewStoreChangeFromCard"),
    attachments.indexOf("async function sendCardCommand"),
  )
  for (const review of [signupReview, storeReview]) {
    assert.match(review, /currentUserIsSignupManager\(\)/)
    assert.match(review, /申請承認権限が必要です/)
    assert.doesNotMatch(review, /canCurrentUserManage\(\)/)
  }
})

test("profile system columns and advisor findings are hardened without widening RLS", async () => {
  const [migration, followup] = await Promise.all([
    read("supabase/migrations/20260910040000_security_authorization_hardening.sql"),
    read("supabase/migrations/20260910050000_security_storage_and_column_privileges.sql"),
  ])
  const profileGuard = migration.slice(
    migration.indexOf("create or replace function public.chat_users_protect_bot_fields"),
    migration.indexOf("drop function if exists public.chat_admin_update_user_access_secure"),
  )
  for (const field of ["id", "created_at", "is_bot", "store_key", "bot_deleted_at", "bot_deleted_by"]) {
    assert.match(profileGuard, new RegExp(`new\\.${field} := old\\.${field}`))
  }
  assert.ok(
    migration.indexOf("drop policy if exists chat_users_select_visible") <
      migration.indexOf("create policy chat_users_select_visible"),
    "the replacement policy must be dropped before a production replay",
  )
  assert.match(migration, /create policy chat_users_select_visible[\s\S]*id = \(select auth\.uid\(\)\)[\s\S]*chat_can_see_directory_user/)
  assert.match(migration, /drop index if exists public\.idx_foodcourt_daily_logs_store_date/)
  assert.match(migration, /alter extension pg_trgm set schema extensions/)
  assert.match(followup, /revoke update on table public\.chat_groups from authenticated/)
  assert.match(followup, /grant update \(group_name, icon_url\) on table public\.chat_groups to authenticated/)
  assert.match(followup, /revoke update on table public\.chat_users from authenticated/)
  assert.match(followup, /grant update \(username, icon_url\) on table public\.chat_users to authenticated/)
  assert.match(followup, /revoke update on table public\.chat_messages from authenticated/)
  assert.match(followup, /grant update \(content, mentions\) on table public\.chat_messages to authenticated/)
  assert.match(followup, /where id = 'chat-icons'/)
  assert.doesNotMatch(followup, /image\/svg\+xml/)
})

test("message edits expose only content and mentions to browser callers", async () => {
  const [page, migration] = await Promise.all([
    read("public/chat/messages.js"),
    read("supabase/migrations/20260910050000_security_storage_and_column_privileges.sql"),
  ])
  const edit = page.slice(
    page.indexOf("async function saveEditedMessage"),
    page.indexOf("async function openForward"),
  )
  assert.match(edit, /\.update\(\{\s*content: text,\s*mentions: collectMentions\(text\)\s*\}\)/)
  for (const protectedColumn of [
    "group_id", "user_id", "username", "kind", "payload", "created_at",
    "reply_to_id", "is_silent", "edited_at", "edit_history",
  ]) {
    assert.doesNotMatch(edit, new RegExp(`${protectedColumn}\\s*:`))
  }
  assert.match(migration, /grant update \(content, mentions\) on table public\.chat_messages to authenticated/)
})

test("legacy Express admin API fails closed before parsing request bodies", async () => {
  const source = await read("src/server.js")
  const auth = source.slice(
    source.indexOf("const requireAdminAuth"),
    source.indexOf("const asPositiveInt"),
  )
  assert.match(auth, /if \(!tokenState\.token\)[\s\S]{0,160}503/)
  assert.doesNotMatch(auth, /if \(!tokenState\.token\)[\s\S]{0,80}return next\(\)/)
  assert.ok(
    source.indexOf('app.use("/api", requireAdminAuth)') <
      source.indexOf('app.use(express.json({ limit: "20mb" }))'),
    "admin authentication must run before the large JSON parser",
  )
  assert.match(source, /const ADMIN_TOKEN_MIN_LENGTH = 32/)
  assert.match(source, /const INGESTION_UPLOAD_MAX_BYTES = 8 \* 1024 \* 1024/)
  assert.match(source, /parsed\.rows\.length > INGESTION_MAX_ROWS/)
  const health = source.slice(
    source.indexOf('app.get("/api/health"'),
    source.indexOf('app.post("/api/admin/auth-token"'),
  )
  assert.match(health, /if \(!authorized\)[\s\S]*adminAuthConfigured/)
  assert.match(health, /res\.status\(configured \? 200 : 503\)/)
})

test("knowledge Office files are safety-checked before extraction or storage", async () => {
  const api = await read("supabase/functions/admin-api/index.ts")
  const safety = api.slice(
    api.indexOf("async function validateStoreKnowledgePayloadSafety"),
    api.indexOf("function normalizeStoreKnowledgeStoreKey"),
  )
  assert.match(safety, /validateDocumentPayloadSafety\(bytes, DOCX_MIME_TYPE\)/)
  assert.match(safety, /validateDocumentPayloadSafety\(bytes, XLSX_MIME_TYPE\)/)
  assert.match(safety, /!hasZipMagicHeader\(bytes\)/)

  const upload = api.slice(
    api.indexOf("async function uploadStoreKnowledgeFile"),
    api.indexOf("async function createStoreKnowledgeDownloadUrl"),
  )
  assert.match(upload, /validateStoreKnowledgePayloadSafety\(kind, bytes\)/)
  assert.match(upload, /contentLength > STORE_KNOWLEDGE_MAX_FILE_BYTES/)

  const analyze = api.slice(
    api.indexOf("async function analyzeStoreKnowledgeImage"),
    api.indexOf("async function processLinePostKnowledge"),
  )
  assert.match(analyze, /validateStoreKnowledgePayloadSafety\(kind, bytes\)/)
  assert.ok(
    analyze.indexOf("validateStoreKnowledgePayloadSafety(kind, bytes)") <
      analyze.indexOf("extractKnowledgeText(kind, bytes)"),
    "archive safety checks must run before extraction",
  )

  const gemini = api.slice(
    api.indexOf("async function callKnowledgeGemini"),
    api.indexOf("function buildKnowledgeBodyFallback"),
  )
  assert.match(gemini, /"x-goog-api-key": geminiApiKey/)
  assert.doesNotMatch(gemini, /generateContent\?key=/)
})

test("weekly report treats AI and tenant data as text and uses local scripts", async () => {
  const page = await read("public/foodcourt-weekly-report.html")
  assert.match(page, /Content-Security-Policy/)
  assert.match(page, /<meta name="referrer" content="no-referrer">/)
  assert.match(page, /<script src="\.\/vendor\/chart\.umd\.min\.js"><\/script>/)
  assert.doesNotMatch(page, /cdn\.jsdelivr\.net|window\.marked|marked\.parse/)
  assert.doesNotMatch(page, /data\.report_html/)
  assert.match(page, /function renderSafeAiReport\(report\)/)
  assert.match(page, /element\.textContent = heading\[2\]/)
  assert.match(page, /paragraph\.textContent = line/)
  assert.match(page, /nameCell\.textContent = tenantName/)
  assert.doesNotMatch(page, /aiReportContainer'\)\.innerHTML|tr\.innerHTML/)
})

test("foodcourt daily-log actions are normalized before persistence", async () => {
  const [api, page] = await Promise.all([
    read("supabase/functions/admin-api/index.ts"),
    read("public/foodcourt-report.html"),
  ])
  const route = api.slice(
    api.indexOf('if (req.method === "PUT" && path === "/foodcourt/daily-logs")'),
    api.indexOf('if (req.method === "DELETE" && path === "/foodcourt/daily-logs")'),
  )
  assert.match(route, /actionInput\.length > 50/)
  assert.match(route, /allowedActionCategories\.has\(requestedCategory\) \? requestedCategory : "other"/)
  assert.match(route, /String\(item\.text \?\? ""\)\.trim\(\)\.slice\(0, 2000\)/)
  assert.match(page, /Object\.prototype\.hasOwnProperty\.call\(CAT_LABEL, a\.cat\)/)
  assert.doesNotMatch(page, /const catCls = `cat-\$\{a\.cat/)
})

test("sensitive browser pages declare a restrictive CSP and no-referrer policy", async () => {
  for (const file of [
    "public/foodcourt-weekly-report.html",
    "public/mtalk_schedule.html",
    "public/room_settings.html",
    "public/jnl2txt.html",
    "public/jnm/index.html",
    "public/mtalk-help.html",
  ]) {
    const page = await read(file)
    assert.match(page, /Content-Security-Policy/, `${file} must declare a CSP`)
    assert.match(page, /name="referrer" content="no-referrer"/, `${file} must suppress referrers`)
    assert.match(page, /object-src 'none'/, `${file} must block plugins`)
    assert.match(page, /base-uri 'self'/, `${file} must pin the base URL`)
  }
})
