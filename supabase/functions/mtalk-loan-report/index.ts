/**
 * mtalk-loan-report — 貸借管理アプリ（MARUGO-s/management の GAS）から、月次の「重複チェック」報告を
 * 専用Bot「貸借管理 報告」（…b074）として M-talk へ届ける。
 *
 *   POST /report  { dedupe_key, title, subtitle?, sections[], note?, links?, dry_run? }
 *
 * 送り先:
 *   - 現在の全権管理者（chat_is_full_admin）それぞれとの1対1（chat_ensure_bot_direct で作成・再利用。
 *     非表示・ゴミ箱は戻す）。全権管理者でなくなった人との既存の1対1には送らない。
 *   - Bot が参加しているグループのルーム（1対1・ゴミ箱・管理者通知を除く）。Botをルームへ招待できるのは
 *     全権管理者だけ（chat_shares_affiliation）、店舗ルームには入れない。
 * 同じルームに同じ dedupe_key は1回だけ（chat_alert_dispatches、kind = loan_duplicate_report）。
 * 1つでも投稿に失敗すると 502（GAS は同じ dedupe_key でやり直し、投稿済みのルームは飛ばされる）。
 * dry_run: true は投稿せず、送り先（already_sent 付き）と組み立てたカードを返す。
 *
 * verify_jwt = false（呼び出し元は Supabase の利用者JWTを持たない）。認可は関数内で
 * LOAN_MTALK_TOKEN の定数時間比較 + HMAC 署名（±5分、mtalk-external-post と同じ方式）で行い、欠けたら常に 401。
 * ブラウザからは呼ばないため CORS ヘッダーは返さない。トークン・本文はログへ出さない。
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import { postChatCardIndependent } from "../_shared/chat_bridge.ts"
import { type BotRoomRow, ExternalPostError, verifyExternalRequest } from "../_shared/mtalk_external_post.ts"
import {
  buildLoanReportCard,
  LOAN_REPORT_BOT_ID,
  LOAN_REPORT_BOT_USERNAME,
  LOAN_REPORT_CARD_KIND,
  LOAN_REPORT_LIMITS,
  LOAN_REPORT_PATH,
  loanReportRooms,
  validateLoanReportInput,
} from "../_shared/mtalk_loan_report.ts"

// deno-lint-ignore no-explicit-any
type DbClient = any

function respond(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  })
}

// 署名の確認に本文が要るので、上限を超えたら読み込みを打ち切る（mtalk-external-post と同じ）
async function readBodyLimited(req: Request, max: number): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > max) throw new ExternalPostError("送信内容が大きすぎます", 413)
  if (!req.body) return ""
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      throw new ExternalPostError("送信内容が大きすぎます", 413)
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) { all.set(c, offset); offset += c.byteLength }
  return new TextDecoder("utf-8", { fatal: true }).decode(all)
}

/** 現在の全権管理者（chat_is_full_admin と同じ判定。Bot・停止・削除・承認前は除く）。 */
async function fullAdmins(supabase: DbClient): Promise<{ id: string; name: string }[]> {
  const { data, error } = await supabase.from("chat_user_access").select("user_id").eq("is_full_admin", true).limit(100)
  if (error) throw new Error("full admin lookup failed")
  const admins: { id: string; name: string }[] = []
  for (const row of data ?? []) {
    const id = String(row.user_id ?? "")
    const { data: ok, error: rpcError } = await supabase.rpc("chat_is_full_admin", { p_user_id: id })
    if (rpcError) throw new Error("full admin check failed")
    if (ok !== true) continue
    const { data: user } = await supabase.from("chat_users").select("username").eq("id", id).maybeSingle()
    admins.push({ id, name: String(user?.username ?? "") })
  }
  return admins
}

/** Bot が参加しているグループのルーム（1対1・ゴミ箱・管理者通知を除く）。 */
async function botRooms(supabase: DbClient): Promise<{ id: number; name: string }[]> {
  const { data: memberships, error } = await supabase.from("chat_group_members").select("group_id").eq("user_id", LOAN_REPORT_BOT_ID).limit(1000)
  if (error) throw new Error("bot rooms failed")
  const groupIds = (memberships ?? []).map((m: { group_id: number }) => Number(m.group_id))
  if (!groupIds.length) return []
  const { data: groups, error: gError } = await supabase.from("chat_groups")
    .select("id, group_name, is_direct, trashed_at, is_admin_notice_room, is_store_room").in("id", groupIds)
  if (gError) throw new Error("bot rooms failed")
  return loanReportRooms((groups ?? []) as BotRoomRow[])
}

async function alreadySent(supabase: DbClient, groupId: number, dedupeKey: string): Promise<boolean> {
  const { data } = await supabase.from("chat_alert_dispatches").select("message_id")
    .eq("kind", LOAN_REPORT_CARD_KIND).eq("chat_group_id", groupId).eq("dedupe_key", dedupeKey).maybeSingle()
  return Boolean(data?.message_id)
}

async function report(supabase: DbClient, bodyText: string) {
  let raw: unknown
  try {
    raw = JSON.parse(bodyText)
  } catch {
    throw new ExternalPostError("送信内容が不正です")
  }
  const input = validateLoanReportInput(raw)
  const { text, cards } = buildLoanReportCard(input)
  const [admins, rooms] = await Promise.all([fullAdmins(supabase), botRooms(supabase)])
  if (!admins.length && !rooms.length) throw new ExternalPostError("送り先（全権管理者・Botが参加しているルーム）がありません", 404)

  if (input.dryRun) {
    // 投稿しない（1対1も作らない）。送り先・送信済みかどうか・カードの確認だけ
    return {
      ok: true,
      dry_run: true,
      bot_name: LOAN_REPORT_BOT_USERNAME,
      admins: admins.map((a) => ({ name: a.name })),
      rooms: await Promise.all(rooms.map(async (r) => ({ group_id: r.id, name: r.name, already_sent: await alreadySent(supabase, r.id, input.dedupeKey) }))),
      text,
      cards,
    }
  }

  const targets: { groupId: number; name: string; kind: "direct" | "room" }[] = rooms.map((r) => ({ groupId: r.id, name: r.name, kind: "room" }))
  for (const admin of admins) {
    const { data: gid, error } = await supabase.rpc("chat_ensure_bot_direct", { p_bot: LOAN_REPORT_BOT_ID, p_user: admin.id })
    const groupId = Number(gid)
    if (error || !Number.isSafeInteger(groupId) || groupId <= 0) {
      console.error("[mtalk-loan-report] direct room failed")
      targets.push({ groupId: 0, name: admin.name, kind: "direct" })
      continue
    }
    targets.push({ groupId, name: admin.name, kind: "direct" })
  }

  const asUser = { id: LOAN_REPORT_BOT_ID, username: LOAN_REPORT_BOT_USERNAME }
  const results: { group_id: number; name: string; kind: string; deduplicated: boolean }[] = []
  let failed = 0
  for (const target of targets) {
    if (!target.groupId) { failed++; continue }
    const posted = await postChatCardIndependent(supabase, {
      groupId: target.groupId, text, cards, kind: LOAN_REPORT_CARD_KIND, dedupeKey: input.dedupeKey, asUser,
    })
    if (!posted.ok) { failed++; continue }
    results.push({ group_id: target.groupId, name: target.name, kind: target.kind, deduplicated: Boolean(posted.skipped) })
  }
  // 1つでも失敗したら 502（GAS は同じ dedupe_key でやり直す。投稿済みのルームは chat_alert_dispatches が飛ばす）
  if (failed) throw new Error("report post failed")
  return { ok: true, bot_name: LOAN_REPORT_BOT_USERNAME, targets: results, deduplicated: results.every((r) => r.deduplicated) }
}

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname.replace(/^.*\/mtalk-loan-report/, "") || "/"
  try {
    if (req.method !== "POST") return respond({ error: "method not allowed" }, 405)
    const bodyText = await readBodyLimited(req, LOAN_REPORT_LIMITS.bodyMaxBytes)
    const authorized = await verifyExternalRequest({
      authorization: req.headers.get("authorization"),
      timestamp: req.headers.get("x-mtalk-timestamp"),
      signature: req.headers.get("x-mtalk-signature"),
      method: req.method,
      path,
      body: bodyText,
    }, Deno.env.get("LOAN_MTALK_TOKEN") ?? "")
    if (!authorized) return respond({ error: "unauthorized" }, 401)

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    if (path === LOAN_REPORT_PATH) return respond(await report(supabase, bodyText))
    return respond({ error: "not found" }, 404)
  } catch (error) {
    if (error instanceof ExternalPostError) return respond({ error: error.message }, error.status)
    // 本文・トークン・DBの詳細は出さない（種類だけ）
    console.error("[mtalk-loan-report] failed:", error instanceof Error ? error.message.slice(0, 80) : "unknown")
    return respond({ error: "M-talkへの送信を完了できませんでした" }, 502)
  }
})
