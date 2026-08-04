import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import {
  aggregateReservationAiItems,
  enumerateReservationDateKeys,
  mergeReservationAiFactsPayloads,
  reservationJstDateKey,
} from "../supabase/functions/_shared/reservation_ai_cache.ts"

test("reservation cache aggregates cancelled, guests, channels, and customer types", () => {
  const totals = aggregateReservationAiItems([
    { source: "tabelog", party_size: 2, guest_type: "new", allergy_label: "" },
    { source: "ikyu", party_size: 4, guest_type: "repeat", allergy_label: "甲殻類" },
    { source: "manual", party_size: null, guest_type: "unknown" },
    { source: "tabelog", party_size: 3, guest_type: "repeat", is_cancelled: true },
  ])
  assert.deepEqual(totals, {
    reservation_count: 3,
    cancelled_count: 1,
    new_count: 1,
    repeat_count: 1,
    unknown_count: 1,
    by_channel: { tabelog: 1, ikyu: 1, manual: 1 },
    allergy_noted_count: 1,
    guest_total: 6,
    guest_unknown_count: 1,
  })
})

test("reservation cache merges daily facts without re-reading or double-counting", () => {
  const merged = mergeReservationAiFactsPayloads([
    {
      totals: {
        reservation_count: 1,
        cancelled_count: 0,
        new_count: 1,
        repeat_count: 0,
        unknown_count: 0,
        by_channel: { tabelog: 1, ikyu: 0, manual: 0 },
        allergy_noted_count: 0,
        guest_total: 2,
        guest_unknown_count: 0,
      },
      items: [{ visit_at: "2026-08-01T09:00:00Z", customer_name: "A" }],
      notes: ["cached"],
    },
    {
      totals: {
        reservation_count: 1,
        cancelled_count: 1,
        new_count: 0,
        repeat_count: 1,
        unknown_count: 0,
        by_channel: { tabelog: 0, ikyu: 1, manual: 0 },
        allergy_noted_count: 1,
        guest_total: 3,
        guest_unknown_count: 0,
      },
      items: [{ visit_at: "2026-08-02T09:00:00Z", customer_name: "B" }],
      notes: ["live"],
    },
  ], 10)

  assert.equal(merged.totals.reservation_count, 2)
  assert.equal(merged.totals.cancelled_count, 1)
  assert.equal(merged.totals.guest_total, 5)
  assert.deepEqual(merged.totals.by_channel, { tabelog: 1, ikyu: 1, manual: 0 })
  assert.deepEqual(merged.notes, ["cached", "live"])
  assert.equal(merged.items.length, 2)
})

test("JST date keys and cache date ranges keep midnight boundaries stable", () => {
  assert.equal(reservationJstDateKey("2026-08-03T15:00:00.000Z"), "2026-08-04")
  assert.deepEqual(
    enumerateReservationDateKeys("2026-08-01", "2026-08-04"),
    ["2026-08-01", "2026-08-02", "2026-08-03"],
  )
})

test("reservation cache schema, cron time, and protected hybrid route are wired", async () => {
  const [migration, summaryMigration, config, ownership, admin, cron, html] = await Promise.all([
    readFile(new URL("../supabase/migrations/20260804035330_reservation_ai_daily_cache.sql", import.meta.url), "utf8"),
    readFile(new URL("../supabase/migrations/20260804040905_reservation_ai_cache_summary.sql", import.meta.url), "utf8"),
    readFile(new URL("../supabase/config.toml", import.meta.url), "utf8"),
    readFile(new URL("../knowledge/supabase-ownership.json", import.meta.url), "utf8"),
    readFile(new URL("../supabase/functions/admin-api/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../supabase/functions/reservation-ai-cache-cron/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/jnm/jnl2txt.html", import.meta.url), "utf8"),
  ])

  assert.match(migration, /create table if not exists public\.reservation_ai_store_cache/)
  assert.match(migration, /create table if not exists public\.reservation_ai_cache_dirty_dates/)
  assert.match(migration, /'37 20 \* \* \*'/)
  assert.match(summaryMigration, /add column if not exists summary_facts jsonb/)
  assert.match(config, /\[functions\.reservation-ai-cache-cron\][\s\S]*verify_jwt = false/)
  assert.match(ownership, /"reservation-ai-cache-cron"/)
  assert.match(admin, /past_cache_plus_live_future/)
  assert.match(admin, /キャッシュ未作成の過去.*DBを直接参照/)
  assert.match(admin, /本日以降の予約は最新DBを直接参照/)
  assert.match(admin, /select\(includeItems \? "fact_date, facts" : "fact_date, summary_facts"\)/)
  assert.match(admin, /path === "\/reservations\/ai-cache\/rebuild"/)
  assert.match(admin, /authResult\.scopeKind !== "cron"/)
  assert.match(cron, /resolve_edge_cron_auth_token/)
  assert.match(cron, /\/reservations\/ai-cache\/rebuild/)
  assert.match(html, /function wantsReservationAiDetail\(query\)/)
  assert.match(html, /params\.set\('include_items', includeItems \? '1' : '0'\)/)
  assert.match(html, /通常分析では省略/)
})
