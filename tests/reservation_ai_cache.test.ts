import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import {
  annotateReservationChronology,
  aggregateReservationAiItems,
  enumerateReservationDateKeys,
  mergeReservationAiFactsPayloads,
  reservationJstDateKey,
} from "../supabase/functions/_shared/reservation_ai_cache.ts"

test("reservation chronology is store-scoped, cross-channel, and time-relative", () => {
  const annotations = annotateReservationChronology([
    {
      source: "tabelog",
      id: 1,
      store_key: "store-a",
      customer_name: "山田 太郎",
      customer_phone: "090-1111-2222",
      visit_at: "2026-01-10T09:00:00Z",
      reservation_key: "A-1",
    },
    {
      source: "ikyu",
      id: 2,
      store_key: "store-a",
      customer_name: "山田太郎",
      customer_phone: "09011112222",
      visit_at: "2026-02-10T09:00:00Z",
      reservation_key: "I-1",
    },
    {
      source: "tabelog",
      id: 3,
      store_key: "store-b",
      customer_name: "山田太郎",
      customer_phone: "09011112222",
      visit_at: "2026-03-10T09:00:00Z",
      reservation_key: "B-1",
    },
    {
      source: "manual",
      id: 4,
      store_key: "store-a",
      customer_name: "山田太郎",
      customer_phone: "09011112222",
      visit_at: "2026-04-10T09:00:00Z",
      reservation_key: "M-1",
    },
  ])

  assert.deepEqual(annotations.get("tabelog:1"), {
    visit_count: 1,
    last_visit_at: null,
    guest_type: "new",
  })
  assert.deepEqual(annotations.get("ikyu:2"), {
    visit_count: 2,
    last_visit_at: "2026-01-10T09:00:00Z",
    guest_type: "repeat",
  })
  assert.deepEqual(annotations.get("tabelog:3"), {
    visit_count: 1,
    last_visit_at: null,
    guest_type: "new",
  })
  assert.deepEqual(annotations.get("manual:4"), {
    visit_count: 3,
    last_visit_at: "2026-02-10T09:00:00Z",
    guest_type: "repeat",
  })
})

test("reservation chronology excludes cancelled and hidden rows and de-duplicates a reservation", () => {
  const annotations = annotateReservationChronology([
    {
      source: "tabelog", id: 1, store_key: "store-a", customer_name: "A",
      customer_phone: "0901", visit_at: "2026-01-01T00:00:00Z", reservation_key: "R-1",
    },
    {
      source: "tabelog", id: 2, store_key: "store-a", customer_name: "A",
      customer_phone: "0901", visit_at: "2026-01-02T00:00:00Z", reservation_key: "R-1",
    },
    {
      source: "ikyu", id: 3, store_key: "store-a", customer_name: "A",
      customer_phone: "0901", visit_at: "2026-01-03T00:00:00Z", reservation_key: "R-2",
      is_cancelled: true,
    },
    {
      source: "manual", id: 4, store_key: "store-a", customer_name: "A",
      customer_phone: "0901", visit_at: "2026-01-04T00:00:00Z", reservation_key: "R-3",
      is_hidden: true,
    },
  ])
  assert.equal(annotations.get("tabelog:1")?.visit_count, 1)
  assert.equal(annotations.get("tabelog:2")?.visit_count, 1)
  assert.equal(annotations.has("ikyu:3"), false)
  assert.equal(annotations.has("manual:4"), false)
})

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
  const [migration, summaryMigration, runsMigration, compactMigration, config, ownership, admin, cron, html] = await Promise.all([
    readFile(new URL("../supabase/migrations/20260804035330_reservation_ai_daily_cache.sql", import.meta.url), "utf8"),
    readFile(new URL("../supabase/migrations/20260804040905_reservation_ai_cache_summary.sql", import.meta.url), "utf8"),
    readFile(new URL("../supabase/migrations/20260804115447_reservation_ai_cache_runs.sql", import.meta.url), "utf8"),
    readFile(new URL("../supabase/migrations/20260804115934_reservation_ai_cache_compact.sql", import.meta.url), "utf8"),
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
  assert.match(runsMigration, /create table if not exists public\.reservation_ai_cache_runs/)
  assert.match(compactMigration, /create table if not exists public\.reservation_ai_cache_coverage/)
  assert.match(compactMigration, /timeout_milliseconds := 300000/)
  assert.match(config, /\[functions\.reservation-ai-cache-cron\][\s\S]*verify_jwt = false/)
  assert.match(ownership, /"reservation-ai-cache-cron"/)
  assert.match(admin, /past_cache_plus_live_future/)
  assert.match(admin, /キャッシュ未作成の過去.*DBを直接参照/)
  assert.match(admin, /本日以降の予約は最新DBを直接参照/)
  assert.match(admin, /RESERVATION_AI_CACHE_STALE_MS/)
  assert.match(admin, /reservation_ai_cache_runs/)
  assert.match(admin, /fetchReservationEventRowsPaged/)
  const aiFactsStart = admin.indexOf("async function fetchReservationAiFactsLive(")
  const aiFactsEnd = admin.indexOf("function jstTodayDateKey(", aiFactsStart)
  assert.ok(aiFactsStart >= 0 && aiFactsEnd > aiFactsStart)
  assert.doesNotMatch(admin.slice(aiFactsStart, aiFactsEnd), /\.limit\(2000\)/)
  assert.match(admin, /select\(includeItems \? "fact_date, facts" : "fact_date, summary_facts"\)/)
  assert.match(admin, /path === "\/reservations\/ai-cache\/rebuild"/)
  assert.match(admin, /authResult\.scopeKind !== "cron"/)
  assert.match(cron, /resolve_edge_cron_auth_token/)
  assert.match(cron, /\/reservations\/ai-cache\/rebuild/)
  assert.match(html, /function wantsReservationAiDetail\(query\)/)
  assert.match(html, /params\.set\('include_items', includeItems \? '1' : '0'\)/)
  assert.match(html, /通常分析では省略/)
})

test("reservation-based visitor structure is limited to the actual store and import start month", async () => {
  const [html, admin, coverageDoc] = await Promise.all([
    readFile(new URL("../public/jnm/jnl2txt.html", import.meta.url), "utf8"),
    readFile(new URL("../supabase/functions/ai-analyze/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../docs/RESERVATION-AI-COVERAGE.md", import.meta.url), "utf8"),
  ])

  assert.match(html, /const RESERVATION_IMPORT_COVERAGE/)
  assert.match(html, /bistrocavacava/)
  assert.match(html, /startMonth:\s*'2026-07'/)
  assert.match(html, /function getReservationImportCoverage\(storeKey = STORE_KEY\)/)
  assert.match(html, /function formatReservationImportCoverageForAi\(storeKey = STORE_KEY\)/)
  const enrichStart = html.indexOf("async function enrichReservationFacts(")
  const enrichEnd = html.indexOf("function formatSignedDelta(", enrichStart)
  assert.ok(enrichStart >= 0 && enrichEnd > enrichStart)
  const enrich = html.slice(enrichStart, enrichEnd)
  assert.match(enrich, /const coverage = getReservationImportCoverage\(\)/)
  assert.match(enrich, /if \(!coverage\) return null/)
  assert.match(enrich, /filter\(\(m\) => String\(m\?\.key \|\| ''\) >= coverage\.startMonth\)/)
  assert.match(enrich, /buildReservationWalkInMonthlyFlow\(coveredMonthlyBreakdown, byMonth\)/)
  assert.match(html, /利用開始前を予約0件・飛び込み100%・予約減少として扱わない/)
  assert.match(admin, /function buildReservationImportCoveragePolicy\(storeKey: string\)/)
  assert.match(admin, /buildJournalAiServerPolicy\("analyze", locationBlock, effectiveStoreKey\)/)
  assert.match(admin, /buildJournalAiServerPolicy\("chat", locationBlock, effectiveStoreKey\)/)
  assert.match(coverageDoc, /Bistro CAVACAVA \(`bistrocavacava`\).*2026-07/)
  assert.match(coverageDoc, /それ以外の店舗 \| 未開始/)
})
