import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0";
import { loadReceiptReportAggregateForRoom } from "./functions/_shared/receipt_report_aggregate.ts";
import { buildReceiptReportFlexMessages } from "./functions/_shared/receipt_report_flex.ts";
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const RECEIPT_MID_REPORT_TITLE = "中間報告";
const RECEIPT_MONTH_END_REPORT_TITLE = "月間報告";
/** 集計締めは営業日5時切替後（16日／翌月1日）だが、LINE送信は店舗向けに10時 */ const REPORT_RUN_HOUR_JST = 10;
const REPORT_RUN_MINUTE_JST = 0;
// 定数時間比較（秘密トークン照合用）
function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}
// コピー&ペースト由来の不可視文字（全角空白・ゼロ幅文字・改行等）を除去する。
// LINEトークンはASCIIのみ。混入すると fetch が "is not a valid ByteString" 例外で
// push が沈黙する（2026-06 bistrocavacava 移管時の実障害。_shared/line_client.ts・
// gmail-alert-cron・reservation-today-cron と同じ対策。この関数だけ未適用だった）。
function sanitizeLineToken(raw) {
  return String(raw ?? "").replace(/[^\x21-\x7e]/g, "");
}

Deno.serve(async (req)=>{
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const lineAccessToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
  if (!supabaseUrl || !serviceRoleKey) {
    return json({
      ok: false,
      error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing."
    }, 500);
  }
  const testEarly = parseReceiptReportTestRequest(req);
  if (testEarly) {
    return await handleReceiptReportTestSend(testEarly, {
      supabaseUrl,
      serviceRoleKey,
      lineAccessToken
    });
  }
  // 非侵襲トークン点検（preflight）: LINE メッセージは一切送らない。
  // 各店舗の解決済みチャネルアクセストークンを /v2/bot/info（読み取り専用）で検証し、
  // 中間/月末レポートの push が成功し得るかを事前確認する。通常cron経路には影響しない。
  // 認可は本処理と同じ CRON_AUTH_TOKEN ゲート（設定時のみ必須・フェイルクローズ）。
  {
    const preflightUrl = new URL(req.url);
    const preflightFlag = String(preflightUrl.searchParams.get("preflight") ?? "").trim().toLowerCase();
    if (preflightFlag === "1" || preflightFlag === "true" || preflightFlag === "yes" || preflightFlag === "on") {
      const pfToken = String(Deno.env.get("CRON_AUTH_TOKEN") ?? "").trim();
      if (pfToken) {
        const pfBearer = String(req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
        if (!constantTimeEqual(pfBearer, pfToken)) {
          return json({ ok: false, error: "unauthorized" }, 401);
        }
      }
      const pfSupabase = createClient(supabaseUrl, serviceRoleKey);
      const { data: pfRooms, error: pfErr } = await pfSupabase
        .from("room_summary_settings")
        .select("receipt_report_store_partition_key, receipt_midreport_enabled, receipt_monthend_report_enabled");
      if (pfErr) {
        return json({ ok: false, mode: "preflight_token_check", error: `Failed to load room_summary_settings: ${pfErr.message}` }, 500);
      }
      const storeKeys = new Set();
      for (const r of (Array.isArray(pfRooms) ? pfRooms : [])) {
        const enabled = r?.receipt_midreport_enabled !== false || r?.receipt_monthend_report_enabled !== false;
        if (!enabled) continue;
        const k = String(r?.receipt_report_store_partition_key ?? "").trim();
        if (k) storeKeys.add(k);
      }
      const results = [];
      for (const k of Array.from(storeKeys).sort()){
        const envKey = `LINE_CHANNEL_ACCESS_TOKEN__${String(k).replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase()}`;
        const perStore = sanitizeLineToken(Deno.env.get(envKey));
        const token = perStore || sanitizeLineToken(lineAccessToken);
        const tokenSource = perStore ? "per_store" : "fallback";
        let status = 0;
        let ok = false;
        let basicId = null;
        let displayName = null;
        if (!token) {
          status = 0;
          ok = false;
        } else {
          try {
            const resp = await fetch("https://api.line.me/v2/bot/info", { headers: { Authorization: `Bearer ${token}` } });
            status = resp.status;
            ok = resp.ok;
            const j = await resp.json().catch(()=>null);
            if (j && typeof j === "object") {
              basicId = j.basicId ?? null;
              displayName = j.displayName ?? null;
            }
          } catch (_e) {
            status = -1;
            ok = false;
          }
        }
        results.push({ store_key: k, token_source: tokenSource, bot_info_status: status, ok, basic_id: basicId, display_name: displayName });
      }
      return json({
        mode: "preflight_token_check",
        note: "No LINE messages were sent. Validated channel access tokens via GET /v2/bot/info.",
        checked: results.length,
        ok_count: results.filter((r)=>r.ok).length,
        ng_count: results.filter((r)=>!r.ok).length,
        fallback_count: results.filter((r)=>r.token_source === "fallback").length,
        stores: results
      }, 200);
    }
  }
  // 管理者へのLINE通知（notify）: スケジュールタスク等から検証レポートを管理者LINEへ送るための内部用。
  // body: { message: string, dry?: boolean }。dry=true なら送信せず宛先(マスク)のみ返す。
  // 宛先=LINE_USER_APPROVAL_ADMIN_USER_IDS、送信元=管理Botトークン(LINE_CHANNEL_ACCESS_TOKEN__ADMIN・サニタイズ)。
  // 認可は本処理と同じ CRON_AUTH_TOKEN ゲート。通常cron経路には影響しない（追加early-returnブランチ）。
  {
    const notifyUrl = new URL(req.url);
    const notifyFlag = String(notifyUrl.searchParams.get("notify") ?? "").trim().toLowerCase();
    if (notifyFlag === "1" || notifyFlag === "true" || notifyFlag === "yes" || notifyFlag === "on") {
      const nfToken = String(Deno.env.get("CRON_AUTH_TOKEN") ?? "").trim();
      if (nfToken) {
        const nfBearer = String(req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
        if (!constantTimeEqual(nfBearer, nfToken)) {
          return json({ ok: false, error: "unauthorized" }, 401);
        }
      }
      let parsed: any = {};
      try { parsed = await req.json(); } catch (_e) { parsed = {}; }
      const message = String(parsed?.message ?? "").trim();
      const dry = parsed?.dry === true || parsed?.dry === "1" || parsed?.dry === 1;
      // 送信元チャネル: body.via で店舗キー指定（既定 admin）。LINE user_id はチャネル単位＝
      // 相手が友だち追加しているBotからしか届かないため、宛先が友だちのチャネルを選べるようにする。
      const viaStore = String(parsed?.via ?? "admin").trim().toLowerCase();
      const viaEnvKey = `LINE_CHANNEL_ACCESS_TOKEN__${viaStore.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase()}`;
      const adminToken = sanitizeLineToken(Deno.env.get(viaEnvKey));
      const adminIdsRaw = String(Deno.env.get("LINE_USER_APPROVAL_ADMIN_USER_IDS") ?? "").trim();
      const adminIds = Array.from(new Set(adminIdsRaw.split(/[,\s]+/).map((s)=>s.trim()).filter((s)=>s.startsWith("U"))));
      // 宛先絞り込み: body.to が指定されたら、許可リスト(adminIds)内で前方一致するIDのみに限定。
      // 許可リスト外には送れない＝任意ユーザーへの送信悪用を防ぐ。未指定なら全管理者。
      const toFilter = String(parsed?.to ?? "").trim();
      const targetIds = toFilter ? adminIds.filter((id)=> id === toFilter || id.startsWith(toFilter)) : adminIds;
      const maskId = (id)=> String(id).length > 12 ? `${String(id).slice(0, 7)}…${String(id).slice(-4)}` : String(id);
      if (dry) {
        return json({ mode: "notify_admin_dry", via: viaStore, to_filter: toFilter || null, recipients: targetIds.length, masked_ids: targetIds.map(maskId), all_admin_count: adminIds.length, has_from_token: !!adminToken }, 200);
      }
      if (!message) return json({ ok: false, mode: "notify_admin", error: "message is empty" }, 400);
      if (!adminToken) return json({ ok: false, mode: "notify_admin", error: `missing ${viaEnvKey}` }, 200);
      if (!adminIds.length) return json({ ok: false, mode: "notify_admin", error: "no admin user ids configured" }, 200);
      if (!targetIds.length) return json({ ok: false, mode: "notify_admin", error: `to filter '${toFilter}' matched no configured admin id` }, 200);
      const sendResults = [];
      for (const uid of targetIds){
        const r = await sendLinePushMessages(uid, [{ type: "text", text: message.slice(0, 4900) }], adminToken);
        sendResults.push({ to: maskId(uid), ok: r.ok, error: r.ok ? undefined : r.error });
      }
      return json({ mode: "notify_admin", to_filter: toFilter || null, recipients: targetIds.length, sent: sendResults.filter((r)=>r.ok).length, failed: sendResults.filter((r)=>!r.ok).length, results: sendResults }, 200);
    }
  }
  // 定期実行(本処理)の認可: CRON_AUTH_TOKEN 設定時のみ Bearer 一致を必須化（フェイルクローズ）。
  // 未設定の間は従来どおり通す＝pg_cron を壊さない。有効化は CRON_AUTH_TOKEN を vault と Edge secret の両方に同値設定。
  const mainCronAuthToken = String(Deno.env.get("CRON_AUTH_TOKEN") ?? "").trim();
  if (mainCronAuthToken) {
    const mainBearer = String(req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!constantTimeEqual(mainBearer, mainCronAuthToken)) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
  }
  if (!lineAccessToken) {
    return json({
      ok: true,
      skipped: true,
      reason: "missing_line_channel_access_token"
    }, 200);
  }
  const now = new Date();
  const jst = toJstDateParts(now);
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // 全ルームのレポート設定（ON/OFF＋送信時刻の個別オーバーライド）を取得。
  const { data: roomSettings, error: settingsError } = await supabase
    .from("room_summary_settings")
    .select("room_id, receipt_midreport_enabled, receipt_monthend_report_enabled, receipt_schedule_override, receipt_midreport_day, receipt_midreport_hour, receipt_midreport_minute, receipt_monthend_day, receipt_monthend_hour, receipt_monthend_minute");
  if (settingsError) {
    return json({
      ok: false,
      error: `Failed to load room_summary_settings: ${settingsError.message}`
    }, 500);
  }

  // いまこの瞬間(JST)に送るべきルームを種別ごとに判定する。
  // ルーム個別設定(override)があればその「日・時・分」、無ければ既定（中間16日 / 月末翌月1日, 10:00）。
  const midRoomIds = [];
  const monthendRoomIds = [];
  for (const row of (Array.isArray(roomSettings) ? roomSettings : [])){
    const roomId = String(row.room_id ?? "").trim();
    if (!roomId) continue;
    const override = row.receipt_schedule_override === true;
    if (row.receipt_midreport_enabled !== false) {
      const d = override && row.receipt_midreport_day != null ? Number(row.receipt_midreport_day) : 16;
      const h = override && row.receipt_midreport_hour != null ? Number(row.receipt_midreport_hour) : REPORT_RUN_HOUR_JST;
      const m = override && row.receipt_midreport_minute != null ? Number(row.receipt_midreport_minute) : REPORT_RUN_MINUTE_JST;
      // 「分ピッタリ一致(=== m)」だと、pg_netの配送遅延や関数のcold startで 10:00:00〜10:00:59 の枠に
      //   処理が入らないと取りこぼし、以降は分が進んで二度と発火しなかった（2026-06-16 16日10:00で実際に未送信）。
      //   そこで「指定時刻〜その時間の終わりまで(>= m, 同一時)」の窓に広げる。重複送信は冪等キー
      //   (report_month, report_kind, room_id) が防ぎ、送信失敗時は予約行を消すので次tickで自動リトライ。
      if (jst.day === d && jst.hour === h && jst.minute >= m) midRoomIds.push(roomId);
    }
    if (row.receipt_monthend_report_enabled !== false) {
      const d = override && row.receipt_monthend_day != null ? Number(row.receipt_monthend_day) : 1;
      const h = override && row.receipt_monthend_hour != null ? Number(row.receipt_monthend_hour) : REPORT_RUN_HOUR_JST;
      const m = override && row.receipt_monthend_minute != null ? Number(row.receipt_monthend_minute) : REPORT_RUN_MINUTE_JST;
      if (jst.day === d && jst.hour === h && jst.minute >= m) monthendRoomIds.push(roomId);
    }
  }

  if (midRoomIds.length === 0 && monthendRoomIds.length === 0) {
    return json({
      ok: true,
      skipped: true,
      reason: "no_rooms_scheduled_now",
      now_jst: `${toJstDateString(jst.year, jst.month, jst.day)} ${String(jst.hour).padStart(2, "0")}:${String(jst.minute).padStart(2, "0")}`
    }, 200);
  }

  const dispatched = [];
  if (midRoomIds.length > 0) {
    dispatched.push(await dispatchReceiptReport(supabase, lineAccessToken, buildScheduleSliceForKind("mid_month", jst), midRoomIds, now));
  }
  if (monthendRoomIds.length > 0) {
    dispatched.push(await dispatchReceiptReport(supabase, lineAccessToken, buildScheduleSliceForKind("month_end", jst), monthendRoomIds, now));
  }
  return json({
    ok: true,
    now_jst: `${toJstDateString(jst.year, jst.month, jst.day)} ${String(jst.hour).padStart(2, "0")}:${String(jst.minute).padStart(2, "0")}`,
    dispatched
  }, 200);
});

/** 指定種別・対象ルーム群へレポートを送信（重複防止＋ログ記録）。スケジュール判定とは分離。 */
/** 店舗別のLINEチャネルトークンを解決（無ければ全体トークンへフォールバック）。
 *  _shared/line_client.ts の resolveChannelAccessToken と同じ env 命名規則（LINE_CHANNEL_ACCESS_TOKEN__<店舗キー大文字>）。
 *  ※ 店舗ごとにLINE公式アカウント（チャネル）が異なるため、全体トークン固定だと既定トークンの店舗以外は push が失敗する。 */ function resolveStoreLineToken(storeKey, fallbackToken) {
  const key = String(storeKey ?? "").trim();
  if (key) {
    const envKey = `LINE_CHANNEL_ACCESS_TOKEN__${key.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase()}`;
    const perStore = sanitizeLineToken(Deno.env.get(envKey));
    if (perStore) return perStore;
  }
  return sanitizeLineToken(fallbackToken);
}
async function dispatchReceiptReport(supabase, lineAccessToken, schedule, targetRoomIds, now) {
  const { data: existingRows, error: existingError } = await supabase.from("line_receipt_mid_reports").select("room_id").eq("report_month", schedule.reportMonth).eq("report_kind", schedule.reportKind).in("room_id", targetRoomIds);
  if (existingError) {
    return {
      report_kind: schedule.reportKind,
      report_month: schedule.reportMonth,
      error: `Failed to load existing line_receipt_mid_reports: ${existingError.message}`
    };
  }
  const existingSet = new Set((Array.isArray(existingRows) ? existingRows : []).map((row)=>String(row?.room_id ?? "").trim()).filter((roomId)=>roomId.length > 0));
  const sentRoomIds = [];
  const skippedRoomIds = [];
  const errors = [];
  for (const roomId of targetRoomIds){
    if (existingSet.has(roomId)) {
      skippedRoomIds.push(roomId);
      continue;
    }
    const { aggregate, storePartitionKey } = await loadReceiptReportAggregateForRoom(supabase, roomId, schedule.periodStartDate, schedule.periodEndDate);
    if (!aggregate || aggregate.receiptCount === 0) {
      skippedRoomIds.push(roomId);
      continue;
    }
    // 同時実行（複数スケジューラ）での二重送信を防ぐため、先に重複防止行を確保してから送信する
    const { error: insertError } = await supabase.from("line_receipt_mid_reports").insert({
      report_month: schedule.reportMonth,
      report_kind: schedule.reportKind,
      room_id: roomId,
      period_start_jst: schedule.periodStartDate,
      period_end_jst: schedule.periodEndDate,
      trigger_type: schedule.triggerType,
      trigger_line_message_id: null,
      receipt_count: aggregate.receiptCount,
      total_gross_sales_yen: aggregate.totalGrossSalesYen,
      total_party_count: aggregate.totalPartyCount,
      total_guest_count: aggregate.totalGuestCount,
      avg_gross_sales_yen: aggregate.avgDailyGrossSalesYen == null ? aggregate.avgGrossSalesYen == null ? null : Math.round(aggregate.avgGrossSalesYen) : aggregate.avgDailyGrossSalesYen,
      avg_party_count: aggregate.avgPartyCount,
      avg_guest_count: aggregate.avgGuestCount,
      sent_at: now.toISOString()
    });
    if (insertError) {
      const code = String(insertError?.code ?? "");
      if (code === "23505") {
        skippedRoomIds.push(roomId);
      } else {
        errors.push(`${roomId}: failed to reserve report log (${insertError.message})`);
      }
      continue;
    }
    const reportMessages = await buildReceiptReportFlexMessages(supabase, aggregate, {
      reportTitle: schedule.reportTitle,
      periodStartDate: schedule.periodStartDate,
      periodEndDate: schedule.periodEndDate,
      storePartitionKey,
      reportKind: schedule.reportKind
    });
    const sendResult = await sendLinePushMessages(roomId, reportMessages, resolveStoreLineToken(storePartitionKey, lineAccessToken));
    if (!sendResult.ok) {
      // 恒久エラー(LINE 400系=友だち解除/Bot退出/無効ルーム等の宛先不達)は再送しても直らないので予約行を残す
      //   ＝同じ部屋を毎分リトライしない（minute>=m の窓中ずっと無駄打ちするのを防ぐ）。
      //   一時エラー(429レート制限/5xx/タイムアウト)だけ予約行を消して次tickで自動再送。
      const errStr = String(sendResult.error ?? "");
      const codeMatch = errStr.match(/\((\d{3})\)/);
      const code = codeMatch ? Number(codeMatch[1]) : 0;
      const permanent = code >= 400 && code < 500 && code !== 429;
      if (!permanent) {
        try {
          await supabase.from("line_receipt_mid_reports").delete().eq("report_month", schedule.reportMonth).eq("report_kind", schedule.reportKind).eq("room_id", roomId);
        } catch (_e) {}
      }
      errors.push(`${roomId}: ${sendResult.error}`);
      continue;
    }
    sentRoomIds.push(roomId);
  }
  return {
    report_kind: schedule.reportKind,
    report_title: schedule.reportTitle,
    report_month: schedule.reportMonth,
    period: {
      start: schedule.periodStartDate,
      end: schedule.periodEndDate
    },
    source_room_count: targetRoomIds.length,
    sent_room_count: sentRoomIds.length,
    skipped_room_count: skippedRoomIds.length,
    error_count: errors.length,
    sent_room_ids: sentRoomIds,
    skipped_room_ids: skippedRoomIds,
    errors
  };
}
/** One-off test push (no DB log). Guard: Edge secret RECEIPT_MIDREPORT_CRON_TEST_KEY via query `key` or header `X-Receipt-Midreport-Test-Key`. */ function parseReceiptReportTestRequest(req) {
  const url = new URL(req.url);
  const flag = (url.searchParams.get("test_receipt_report") ?? url.searchParams.get("test_receipt_midreport") ?? "").trim().toLowerCase();
  if (flag !== "1" && flag !== "true" && flag !== "yes" && flag !== "on") {
    return null;
  }
  const roomId = (url.searchParams.get("room_id") ?? "").trim();
  if (!roomId) return null;
  const kindRaw = (url.searchParams.get("report_kind") ?? "mid_month").trim().toLowerCase();
  const reportKind = kindRaw === "month_end" ? "month_end" : "mid_month";
  const now = new Date();
  const jst = toJstDateParts(now);
  let year = Number(url.searchParams.get("year"));
  let month = Number(url.searchParams.get("month"));
  if (!Number.isInteger(year) || year < 2000 || year > 2100) year = jst.year;
  if (!Number.isInteger(month) || month < 1 || month > 12) month = jst.month;
  const keyFromQuery = (url.searchParams.get("key") ?? "").trim();
  const keyFromHeader = (req.headers.get("x-receipt-midreport-test-key") ?? "").trim();
  const storeKeyRaw = (url.searchParams.get("store_partition_key") ?? "").trim().toLowerCase();
  const storePartitionKey = /^[a-z0-9]{2,120}$/.test(storeKeyRaw) ? storeKeyRaw : null;
  return {
    roomId,
    reportKind,
    year,
    month,
    storePartitionKey,
    keyFromQuery,
    keyFromHeader
  };
}
async function handleReceiptReportTestSend(spec, deps) {
  const testKey = (Deno.env.get("RECEIPT_MIDREPORT_CRON_TEST_KEY") ?? "").trim();
  if (!testKey) {
    return json({
      ok: false,
      error: "Test send is disabled. Set Edge secret RECEIPT_MIDREPORT_CRON_TEST_KEY."
    }, 503);
  }
  const provided = spec.keyFromHeader || spec.keyFromQuery;
  if (!provided || !constantTimeEqual(provided, testKey)) {
    return json({
      ok: false,
      error: "Forbidden"
    }, 403);
  }
  if (!deps.lineAccessToken) {
    return json({
      ok: false,
      error: "LINE_CHANNEL_ACCESS_TOKEN is missing."
    }, 500);
  }
  const slice = buildReceiptReportTestSchedule(spec.reportKind, spec.year, spec.month);
  const supabase = createClient(deps.supabaseUrl, deps.serviceRoleKey);
  const { aggregate, storePartitionKey } = await loadReceiptReportAggregateForRoom(supabase, spec.roomId, slice.periodStartDate, slice.periodEndDate, spec.storePartitionKey);
  if (!storePartitionKey) {
    return json({
      ok: true,
      skipped: true,
      mode: "test_receipt_report",
      reason: "store_not_resolved_for_room",
      report_kind: slice.reportKind,
      period: {
        start: slice.periodStartDate,
        end: slice.periodEndDate
      },
      room_id: spec.roomId
    }, 200);
  }
  if (!aggregate || aggregate.receiptCount === 0) {
    return json({
      ok: true,
      skipped: true,
      mode: "test_receipt_report",
      reason: "no_receipt_entries_in_period_for_store",
      report_kind: slice.reportKind,
      report_month: slice.reportMonth,
      store_partition_key: storePartitionKey,
      period: {
        start: slice.periodStartDate,
        end: slice.periodEndDate
      },
      room_id: spec.roomId
    }, 200);
  }
  const reportMessages = await buildReceiptReportFlexMessages(supabase, aggregate, {
    reportTitle: slice.reportTitle,
    periodStartDate: slice.periodStartDate,
    periodEndDate: slice.periodEndDate,
    storePartitionKey,
    reportKind: slice.reportKind
  });
  const sendResult = await sendLinePushMessages(spec.roomId, reportMessages, resolveStoreLineToken(storePartitionKey, deps.lineAccessToken));
  if (!sendResult.ok) {
    return json({
      ok: false,
      error: sendResult.error,
      mode: "test_receipt_report"
    }, 502);
  }
  return json({
    ok: true,
    mode: "test_receipt_report",
    note: "Preview send only. line_receipt_mid_reports was NOT updated.",
    report_kind: slice.reportKind,
    report_title: slice.reportTitle,
    report_month: slice.reportMonth,
    store_partition_key: storePartitionKey,
    period: {
      start: slice.periodStartDate,
      end: slice.periodEndDate
    },
    room_id: spec.roomId,
    receipt_count: aggregate.receiptCount,
    total_gross_sales_yen: aggregate.totalGrossSalesYen
  }, 200);
}
function buildReceiptReportTestSchedule(reportKind, year, month) {
  const reportMonth = toJstDateString(year, month, 1);
  const rangeStartIso = buildJstDateStartUtcIso(year, month, 1);
  if (reportKind === "mid_month") {
    return {
      reportKind: "mid_month",
      reportTitle: RECEIPT_MID_REPORT_TITLE,
      reportMonth,
      periodStartDate: reportMonth,
      periodEndDate: toJstDateString(year, month, 15),
      rangeStartIso,
      rangeEndIso: buildJstDateStartUtcIso(year, month, 16)
    };
  }
  const monthLastDay = getJstMonthLastDay(year, month);
  const nextMonth = shiftJstYearMonth(year, month, 1);
  return {
    reportKind: "month_end",
    reportTitle: RECEIPT_MONTH_END_REPORT_TITLE,
    reportMonth,
    periodStartDate: reportMonth,
    periodEndDate: toJstDateString(year, month, monthLastDay),
    rangeStartIso,
    rangeEndIso: buildJstDateStartUtcIso(nextMonth.year, nextMonth.month, 1)
  };
}
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}
function toJstDateParts(base = new Date()) {
  const jst = new Date(base.getTime() + JST_OFFSET_MS);
  return {
    year: jst.getUTCFullYear(),
    month: jst.getUTCMonth() + 1,
    day: jst.getUTCDate(),
    hour: jst.getUTCHours(),
    minute: jst.getUTCMinutes()
  };
}
function toJstDateString(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function buildJstDateStartUtcIso(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day, -9, 0, 0, 0)).toISOString();
}
function shiftJstYearMonth(year, month, deltaMonths) {
  const shifted = new Date(Date.UTC(year, month - 1 + deltaMonths, 1));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1
  };
}
function getJstMonthLastDay(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
/** 種別と現在JSTから、レポートの対象月・期間を決める（送信時刻の判定とは分離。期間は従来同等）。 */
function buildScheduleSliceForKind(kind, jst) {
  if (kind === "mid_month") {
    // 中間: 当月1〜15日（送信日時はルームごとに可変。既定は16日10:00）
    const reportMonth = toJstDateString(jst.year, jst.month, 1);
    return {
      reportKind: "mid_month",
      reportTitle: RECEIPT_MID_REPORT_TITLE,
      // trigger_type は line_receipt_mid_reports の CHECK 制約の許可値に合わせる
      //   （per-roomスケジュール化で "per_room_schedule" を入れていたが未許可値でINSERT失敗＝送信ゼロの真因）。
      triggerType: "day15_post",
      reportMonth,
      periodStartDate: reportMonth,
      periodEndDate: toJstDateString(jst.year, jst.month, 15),
      rangeStartIso: buildJstDateStartUtcIso(jst.year, jst.month, 1),
      rangeEndIso: buildJstDateStartUtcIso(jst.year, jst.month, 16)
    };
  }
  // 月末: 前月まるごと（送信日時はルームごとに可変。既定は翌月1日10:00）
  const prev = shiftJstYearMonth(jst.year, jst.month, -1);
  const reportMonth = toJstDateString(prev.year, prev.month, 1);
  const monthLastDay = getJstMonthLastDay(prev.year, prev.month);
  const nextMonth = shiftJstYearMonth(prev.year, prev.month, 1);
  return {
    reportKind: "month_end",
    reportTitle: RECEIPT_MONTH_END_REPORT_TITLE,
    triggerType: "month_end_post", // CHECK制約の許可値（per_room_schedule は未許可）
    reportMonth,
    periodStartDate: reportMonth,
    periodEndDate: toJstDateString(prev.year, prev.month, monthLastDay),
    rangeStartIso: buildJstDateStartUtcIso(prev.year, prev.month, 1),
    rangeEndIso: buildJstDateStartUtcIso(nextMonth.year, nextMonth.month, 1)
  };
}
async function sendLinePushMessages(to, messages, token) {
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({
      to,
      messages: messages.slice(0, 5)
    })
  });
  if (!response.ok) {
    const err = await response.text();
    return {
      ok: false,
      error: `LINE push API error (${response.status}): ${err}`
    };
  }
  return {
    ok: true
  };
}
