import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import { refreshStoreReview, refreshCompetitorReviews } from "../_shared/competitor_review_context.ts"
import { pushLineTextToTarget, resolveChannelAccessToken } from "../_shared/line_client.ts"

// 自店舗・登録済み競合店の「新着口コミ」をLINEに通知する cron（1日1回）。
//  - 対象は room_summary_settings.review_alert_enabled=true の部屋（receipt_report_store_partition_key で店舗に紐づく）。
//  - 各店舗について、自店舗レビュー(store_review_places)・登録競合(competitor_places)を
//    refreshStoreReview/refreshCompetitorReviews で再取得（Google Places→スナップショット保存は既存ロジックを再利用）。
//  - 新着判定は user_ratings_total（累計口コミ数）の増分。last_alerted_rating_total がNULLの初回は
//    ベースライン記録のみ（既存の口コミをまとめて通知しない）。増分があった回だけ対象ルームへpush。
//  - 冪等: 通知後に last_alerted_rating_total を更新するので、同日中に複数回起動しても二重通知しない。
// verify_jwt=false で pg_cron(invoke_review_alert_cron)から起動。

type DbClient = ReturnType<typeof createClient>

type RoomRow = {
  room_id: string
  receipt_report_store_partition_key: string | null
}

type PlaceCheckResult = {
  checked: boolean
  alerted: boolean
  error?: string
}

type StoreReviewPlaceRow = {
  id: number
  place_id: string | null
  store_name: string | null
  google_maps_uri: string | null
  last_alerted_rating_total: number | null
}

type CompetitorPlaceRow = {
  id: number
  competitor_name: string | null
  place_id: string | null
  google_maps_uri: string | null
  last_alerted_rating_total: number | null
}

type ReviewSnapshotRow = {
  rating: number | null
  user_ratings_total: number | null
  review_excerpt: string | null
}

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing." }, 500)
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey) as unknown as DbClient
  const url = new URL(req.url)
  const dryRun = ["1", "true", "yes", "on"].includes((url.searchParams.get("dry_run") ?? "").toLowerCase())

  // 1) 通知ONの部屋 → 店舗キーごとにルームIDをまとめる（1店舗を複数ルームが購読しているケースにも対応）
  const { data: roomRows, error: roomErr } = await supabase
    .from("room_summary_settings")
    .select("room_id, receipt_report_store_partition_key")
    .eq("review_alert_enabled", true)
  if (roomErr) return json({ ok: false, error: `rooms load failed: ${roomErr.message}` }, 500)

  const roomsByStore = new Map<string, string[]>()
  for (const r of (Array.isArray(roomRows) ? roomRows : []) as RoomRow[]) {
    const storeKey = String(r.receipt_report_store_partition_key ?? "").trim()
    const roomId = String(r.room_id ?? "").trim()
    if (!storeKey || !roomId) continue
    const list = roomsByStore.get(storeKey)
    if (list) list.push(roomId)
    else roomsByStore.set(storeKey, [roomId])
  }

  if (roomsByStore.size === 0) {
    return json({ ok: true, no_target: true, room_count: 0 }, 200)
  }

  const errors: string[] = []
  let selfChecked = 0
  let selfAlerted = 0
  let competitorChecked = 0
  let competitorAlerted = 0

  for (const [storeKey, roomIds] of roomsByStore) {
    const token = resolveChannelAccessToken(storeKey)

    // --- 自店舗の口コミ ---
    try {
      const result = await checkStoreReviewAndAlert(supabase, storeKey, roomIds, token, dryRun)
      if (result.checked) selfChecked++
      if (result.alerted) selfAlerted++
      if (result.error) errors.push(`self:${storeKey}: ${result.error}`)
    } catch (e) {
      errors.push(`self:${storeKey}: ${e instanceof Error ? e.message : String(e)}`)
    }

    // --- 登録済み競合の口コミ ---
    try {
      const { data: compRows, error: compErr } = await supabase
        .from("competitor_places")
        .select("id, competitor_name, place_id, google_maps_uri, last_alerted_rating_total")
        .eq("store_partition_key", storeKey)
        .eq("is_active", true)
        .eq("source", "google_places")
      if (compErr) throw compErr
      for (const comp of (Array.isArray(compRows) ? compRows : []) as CompetitorPlaceRow[]) {
        if (!comp.place_id) continue
        try {
          const result = await checkCompetitorReviewAndAlert(supabase, storeKey, comp, roomIds, token, dryRun)
          if (result.checked) competitorChecked++
          if (result.alerted) competitorAlerted++
          if (result.error) errors.push(`competitor:${storeKey}:${comp.id}: ${result.error}`)
        } catch (e) {
          errors.push(`competitor:${storeKey}:${comp.id}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    } catch (e) {
      errors.push(`competitor-list:${storeKey}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return json({
    ok: true,
    dry_run: dryRun,
    store_count: roomsByStore.size,
    self_checked: selfChecked,
    self_alerted: selfAlerted,
    competitor_checked: competitorChecked,
    competitor_alerted: competitorAlerted,
    errors,
  }, 200)
})

async function checkStoreReviewAndAlert(
  supabase: DbClient,
  storeKey: string,
  roomIds: string[],
  token: string,
  dryRun: boolean,
): Promise<PlaceCheckResult> {
  const { data: placeData, error: placeErr } = await supabase
    .from("store_review_places")
    .select("id, place_id, store_name, google_maps_uri, last_alerted_rating_total")
    .eq("store_partition_key", storeKey)
    .eq("is_active", true)
    .maybeSingle()
  if (placeErr) return { checked: false, alerted: false, error: `load failed: ${placeErr.message}` }
  const placeRow = placeData as StoreReviewPlaceRow | null
  if (!placeRow || !placeRow.place_id) return { checked: false, alerted: false }

  // Google Places 再取得＋スナップショット保存（既存の「自店舗口コミを更新」と同じロジックを再利用）
  await refreshStoreReview(supabase, { store_key: storeKey })

  const { data: snapData, error: snapErr } = await supabase
    .from("store_review_snapshots")
    .select("rating, user_ratings_total, review_excerpt")
    .eq("store_review_place_id", placeRow.id)
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (snapErr) return { checked: true, alerted: false, error: `snapshot load failed: ${snapErr.message}` }
  const snap = snapData as ReviewSnapshotRow | null

  const currentTotal = snap?.user_ratings_total != null ? Number(snap.user_ratings_total) : null
  if (currentTotal == null || !Number.isFinite(currentTotal)) return { checked: true, alerted: false }

  const lastAlerted = placeRow.last_alerted_rating_total != null ? Number(placeRow.last_alerted_rating_total) : null

  if (lastAlerted == null) {
    // 初回チェック：既存件数をベースラインとして記録するだけ（通知しない）
    if (!dryRun) {
      await supabase.from("store_review_places").update({ last_alerted_rating_total: currentTotal }).eq("id", placeRow.id)
    }
    return { checked: true, alerted: false }
  }

  if (currentTotal <= lastAlerted) return { checked: true, alerted: false }

  const delta = currentTotal - lastAlerted
  if (!dryRun) {
    const text = buildAlertText({
      kind: "self",
      name: String(placeRow.store_name || storeKey),
      delta,
      total: currentTotal,
      rating: snap?.rating != null ? Number(snap.rating) : null,
      excerpt: snap?.review_excerpt ? String(snap.review_excerpt) : null,
      mapsUri: placeRow.google_maps_uri ? String(placeRow.google_maps_uri) : null,
    })
    for (const roomId of roomIds) {
      await pushLineTextToTarget(roomId, text, token)
    }
    await supabase.from("store_review_places").update({ last_alerted_rating_total: currentTotal }).eq("id", placeRow.id)
  }
  return { checked: true, alerted: true }
}

async function checkCompetitorReviewAndAlert(
  supabase: DbClient,
  storeKey: string,
  comp: CompetitorPlaceRow,
  roomIds: string[],
  token: string,
  dryRun: boolean,
): Promise<PlaceCheckResult> {
  // Google Places 再取得＋スナップショット保存（既存の「口コミ情報を更新」と同じロジックを再利用。id指定でこの1件だけ）
  await refreshCompetitorReviews(supabase, { store_key: storeKey, id: comp.id })

  const { data: snapData, error: snapErr } = await supabase
    .from("competitor_review_snapshots")
    .select("rating, user_ratings_total, review_excerpt")
    .eq("competitor_place_id", comp.id)
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (snapErr) return { checked: true, alerted: false, error: `snapshot load failed: ${snapErr.message}` }
  const snap = snapData as ReviewSnapshotRow | null

  const currentTotal = snap?.user_ratings_total != null ? Number(snap.user_ratings_total) : null
  if (currentTotal == null || !Number.isFinite(currentTotal)) return { checked: true, alerted: false }

  const lastAlerted = comp.last_alerted_rating_total != null ? Number(comp.last_alerted_rating_total) : null

  if (lastAlerted == null) {
    if (!dryRun) {
      await supabase.from("competitor_places").update({ last_alerted_rating_total: currentTotal }).eq("id", comp.id)
    }
    return { checked: true, alerted: false }
  }

  if (currentTotal <= lastAlerted) return { checked: true, alerted: false }

  const delta = currentTotal - lastAlerted
  if (!dryRun) {
    const text = buildAlertText({
      kind: "competitor",
      name: String(comp.competitor_name || "競合店"),
      delta,
      total: currentTotal,
      rating: snap?.rating != null ? Number(snap.rating) : null,
      excerpt: snap?.review_excerpt ? String(snap.review_excerpt) : null,
      mapsUri: comp.google_maps_uri ? String(comp.google_maps_uri) : null,
    })
    for (const roomId of roomIds) {
      await pushLineTextToTarget(roomId, text, token)
    }
    await supabase.from("competitor_places").update({ last_alerted_rating_total: currentTotal }).eq("id", comp.id)
  }
  return { checked: true, alerted: true }
}

function buildAlertText(params: {
  kind: "self" | "competitor"
  name: string
  delta: number
  total: number
  rating: number | null
  excerpt: string | null
  mapsUri: string | null
}): string {
  const lines: string[] = []
  const label = params.kind === "self" ? "📢 自店舗に新しい口コミ" : "📢 競合店に新しい口コミ"
  lines.push(label)
  lines.push(`${params.name}`)
  const ratingText = params.rating != null ? `★${params.rating.toFixed(1)}` : "評価なし"
  lines.push(`${ratingText}（新着${params.delta}件・累計${params.total}件）`)
  if (params.excerpt) {
    const excerpt = params.excerpt.length > 200 ? params.excerpt.slice(0, 200) + "…" : params.excerpt
    lines.push("")
    lines.push(`最新の口コミ:\n${excerpt}`)
  }
  if (params.mapsUri) {
    lines.push("")
    lines.push(params.mapsUri)
  }
  return lines.join("\n").slice(0, 4900)
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  })
}
