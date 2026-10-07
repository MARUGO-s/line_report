import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { signExternalRequest, verifyExternalRequest } from "../supabase/functions/_shared/mtalk_external_post.ts"
import {
  buildLoanReportCard,
  LOAN_REPORT_BOT_ID,
  LOAN_REPORT_CARD_KIND,
  LOAN_REPORT_LIMITS,
  LOAN_REPORT_PATH,
  loanReportRooms,
  validateLoanReportInput,
} from "../supabase/functions/_shared/mtalk_loan_report.ts"

const root = new URL("..", import.meta.url)
const read = (relative: string) => readFile(new URL(relative, root), "utf8")
const MIGRATION = "supabase/migrations/20261007120000_chat_loan_report_bot.sql"

const report = (extra: Record<string, unknown> = {}) => ({
  dedupe_key: "loan-duplicate:2026-09",
  title: "重複チェック（2026年9月分）",
  subtitle: "2026/09/01〜2026/09/30 · 10/01 06:00 作成",
  sections: [
    {
      heading: "重複の疑いが強い",
      fields: [{ label: "件数", value: "3件（2グループ）" }, { label: "重複分", value: "¥15,354" }],
      items: ["2026-09-03 焼肉マルゴ→MARUGO MARUNOUCHI シャンティ ¥3,948 ×6"],
    },
  ],
  note: "重複と確認できた行は、貸借管理の「逆取引修正」で取り消してください（行は削除しない）。",
  links: [{ label: "重複チェックを開く", url: "https://marugo-s.github.io/management/pages/marugo.html" }],
  ...extra,
})

test("報告の本文を検証し、カードを組み立てる", () => {
  const input = validateLoanReportInput(report())
  assert.equal(input.dedupeKey, "loan-duplicate:2026-09")
  assert.equal(input.dryRun, false)
  assert.equal(input.links.length, 1)
  const { text, cards } = buildLoanReportCard(input)
  assert.match(text, /^\[貸借管理\] 重複チェック（2026年9月分）/)
  assert.equal(cards[0].header?.eyebrow, "貸借管理")
  assert.equal(cards[0].actions?.[0].url, "https://marugo-s.github.io/management/pages/marugo.html")
  assert.ok(cards[0].sections.some((s) => s.type === "fields" && s.rows.some((r) => r.label === "重複分")))
  assert.equal(validateLoanReportInput(report({ dry_run: true })).dryRun, true)
})

test("許可していないリンクは落とし、不正な本文・個人情報らしき文字列は受け付けない", () => {
  const input = validateLoanReportInput(report({ links: [{ label: "外部", url: "https://example.com/x" }] }))
  assert.deepEqual(input.links, [])
  assert.throws(() => validateLoanReportInput(report({ dedupe_key: "short" })), /dedupe_key/)
  assert.throws(() => validateLoanReportInput(report({ title: "" })), /タイトル/)
  assert.throws(() => validateLoanReportInput(report({ sections: [] })), /内容がありません/)
  assert.throws(() => validateLoanReportInput(report({ sections: Array(LOAN_REPORT_LIMITS.sectionsMax + 1).fill(report().sections[0]) })), /sections/)
  assert.throws(() => validateLoanReportInput(report({ note: "連絡先 090-1234-5678" })), (e: Error & { status?: number }) => e.status === 422)
  assert.throws(() => validateLoanReportInput([]), /不正/)
})

test("送り先のルームは、1対1・ゴミ箱・管理者通知を除く", () => {
  const rooms = loanReportRooms([
    { id: 30, group_name: "BistroCAVACAVA", is_direct: false, trashed_at: null, is_admin_notice_room: false },
    { id: 40, group_name: "貸借管理 報告・板川", is_direct: true, trashed_at: null },
    { id: 41, group_name: "古いルーム", is_direct: false, trashed_at: "2026-10-01T00:00:00Z" },
    { id: 42, group_name: "管理者通知", is_direct: false, trashed_at: null, is_admin_notice_room: true },
    { id: 12, group_name: "本部", is_direct: false, trashed_at: null },
  ])
  assert.deepEqual(rooms, [{ id: 12, name: "本部" }, { id: 30, name: "BistroCAVACAVA" }])
})

test("署名は mtalk-external-post と同じ方式で、別の合言葉では通らない", async () => {
  const token = "t".repeat(40)
  const body = JSON.stringify(report())
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = await signExternalRequest(token, { timestamp, method: "POST", path: LOAN_REPORT_PATH, body })
  const input = { authorization: `Bearer ${token}`, timestamp, signature, method: "POST", path: LOAN_REPORT_PATH, body }
  assert.equal(await verifyExternalRequest(input, token), true)
  assert.equal(await verifyExternalRequest(input, "g".repeat(40)), false)
  assert.equal(await verifyExternalRequest({ ...input, body: body + " " }, token), false)
  assert.equal(await verifyExternalRequest(input, ""), false)
})

test("Bot は店舗に属さない固定IDで、1対1・招待は全権管理者だけ", async () => {
  const sql = await read(MIGRATION)
  assert.equal(LOAN_REPORT_BOT_ID, "00000000-0000-4000-8000-00000000b074")
  assert.equal(LOAN_REPORT_CARD_KIND, "loan_duplicate_report")
  assert.match(sql, /'00000000-0000-4000-8000-00000000b074'/)
  assert.match(sql, /'loan-report-bot@marugo\.invalid'/)
  assert.match(sql, /'infinity'/)
  assert.match(sql, /insert into public\.chat_users \(id, username, is_bot\)\s+values \('00000000-0000-4000-8000-00000000b074', '貸借管理 報告', true\)/)
  assert.doesNotMatch(sql, /store_key\s*=\s*'/)
  const fn = sql.slice(sql.search(/create or replace function public\.chat_shares_affiliation/))
  assert.match(fn, /set search_path = pg_catalog, public/)
  assert.match(fn, /if p_b = v_loan_report_bot then\s+return public\.chat_is_full_admin\(p_a\);/)
  assert.match(fn, /if p_a = v_loan_report_bot then\s+return public\.chat_is_full_admin\(p_b\);/)
  assert.match(sql, /revoke all on function public\.chat_shares_affiliation\(uuid, uuid\)\s+from public, anon, authenticated;/)
  assert.match(sql, /grant execute on function public\.chat_shares_affiliation\(uuid, uuid\)\s+to postgres, service_role;/)
})

test("M-talk画面: 報告Botは全権管理者にだけBotタブで見え、店舗ルーム・管理者通知には招待しない", async () => {
  const [core, profile, rooms, config, ownership, fn] = await Promise.all([
    read("public/chat/core.js"), read("public/chat/profile.js"), read("public/chat/rooms.js"),
    read("supabase/config.toml"), read("knowledge/supabase-ownership.json"), read("supabase/functions/mtalk-loan-report/index.ts"),
  ])
  assert.match(core, /const LOAN_REPORT_BOT_USER_ID = '00000000-0000-4000-8000-00000000b074';/)
  assert.match(profile, /if \(isLoanReportBot\(user\)\) return currentChatAccess\?\.is_full_admin === true;/)
  assert.match(rooms, /\(isStoreBot\(user\) \|\| isLoanReportBot\(user\)\) && sharesAffiliationWith\(user\)/)
  assert.match(rooms, /invitingLoanReportBot && \(group\.is_store_room \|\| group\.store_key \|\| group\.is_admin_notice_room\)/)
  assert.match(config, /\[functions\.mtalk-loan-report\]\s+verify_jwt = false/)
  assert.ok(JSON.parse(ownership).ownedFunctions.includes("mtalk-loan-report"))
  assert.match(fn, /Deno\.env\.get\("LOAN_MTALK_TOKEN"\)/)
  assert.doesNotMatch(fn, /GOURMET_MTALK_TOKEN/)
  assert.match(fn, /chat_is_full_admin/)
  assert.match(fn, /chat_ensure_bot_direct/)
})
