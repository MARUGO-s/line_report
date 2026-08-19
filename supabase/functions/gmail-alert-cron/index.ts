import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0";
import { issueAdminDashboardLoginLinkToken } from "../_shared/admin_dashboard_link_auth.ts";
import { buildReservationCalendarPageUrl } from "../_shared/reservation_calendar_link.ts";
import { resolveReceiptNamePartitionKey } from "../_shared/receipt_store_name_resolve.ts";
import { pilotStorePartitionKeysMatch } from "../_shared/receipt_sheets_store_catalog.ts";
import { resolveStorePartitionKeyForRoom } from "../_shared/receipt_report_aggregate.ts";
import { recordLineWebhookDeliveryLog } from "../_shared/line_webhook_delivery_log.ts";
import { isBlockedByMarugosecondLockdown } from "../_shared/line_client.ts";
import { resolveGroqTextModel } from "../_shared/groq_model.ts";
import {
  type ChatCard,
  postChatCardIndependent,
  resolveChatGroupId,
  resolveChatGroupIdByStore,
} from "../_shared/chat_bridge.ts";
import {
  isLikelyReservationNotificationMail,
  resolveReservationYear,
} from "../_shared/reservation_mail_rules.ts";

type GmailAlertEnv = {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  query: string;
  maxMessages: number;
  scanMessages: number;
  fallbackTargetRoomId: string;
  aiEnabled: boolean;
  aiApiKey: string;
  aiMaxBodyChars: number;
};

type GmailAlertEnvState =
  | { ok: true; env: GmailAlertEnv }
  | { ok: false; missing: string[] };

type GmailMessageListItem = {
  id: string;
  threadId: string | null;
};

type GmailMessageAlert = {
  id: string;
  threadId: string | null;
  subject: string;
  from: string;
  snippet: string;
  internalDateIso: string | null;
  eventLabel: ReservationEventLabel;
  reservation: ReservationMailDetails | null;
  reservationExtractSource: "rule" | "ai" | "rule_plus_ai" | "none";
};

type IgnoredGmailMessage = {
  id: string;
  threadId: string | null;
  subject: string;
  from: string;
  internalDateIso: string | null;
  reason: "unsupported_route" | "non_reservation_notification";
};

type GmailMessageFetchResult =
  | { kind: "alert"; alert: GmailMessageAlert }
  | { kind: "ignored"; message: IgnoredGmailMessage };

type ReservationEventLabel = "新規予約" | "予約変更" | "予約キャンセル";

type LineMessagePayload = {
  text: string;
  richMessages: Array<Record<string, unknown>>;
  /** chat.html へ複製するときのカード。LINE 送信では使わない。 */
  chatCards: ChatCard[];
};

type GmailAlertDeliveryBatch = {
  batchKey: string;
  storeKey: string | null;
  alerts: GmailMessageAlert[];
  targets: GmailAlertTarget[];
};

type ReservationMailDetails = {
  reservationSite: string | null;
  storeName: string | null;
  reservationNo: string | null;
  notificationNo: string | null;
  vPointUsage: string | null;
  visitDateTime: string | null;
  partySize: string | null;
  plan: string | null;
  paymentMethod: string | null;
  totalAmount: string | null;
  seatName: string | null;
  representativeName: string | null;
  representativePhone: string | null;
  allergy: string | null;
  requestNote: string | null;
  reservationHistory: string | null;
  /** Flex 予約回数欄: 1要素＝1段落（見出しと日時を分離） */
  reservationHistoryParagraphs?: string[] | null;
};

type ReservationVisitRecordResult = {
  visit_count: number;
  cancelled_count: number;
  recent_visits: Array<
    {
      visit_at?: string | null;
      is_cancelled?: boolean;
      store_name?: string | null;
    }
  >;
};

// is:unread を付けない: 店舗が予約メールを開封(既読)していても取りこぼさないため。
// 二重通知は gmail_reservation_alert_logs（通知済みID）で防止するので、未読縛りは不要。
const DEFAULT_GMAIL_ALERT_QUERY =
  "is:inbox newer_than:7d (予約 OR reservation OR booking)";
const DEFAULT_GMAIL_ALERT_MAX_MESSAGES = 20;
const MAX_GMAIL_ALERT_MAX_MESSAGES = 20;
const DEFAULT_GMAIL_ALERT_SCAN_MESSAGES = 500;
const MAX_GMAIL_ALERT_SCAN_MESSAGES = 500;
const DEFAULT_GMAIL_ALERT_AI_MAX_BODY_CHARS = 6000;
const MIN_GMAIL_ALERT_AI_MAX_BODY_CHARS = 1500;
const MAX_GMAIL_ALERT_AI_MAX_BODY_CHARS = 12000;
const GMAIL_ALERT_AI_MIN_CONFIDENCE = 0.55;
const RESERVATION_CANCEL_SHORT_RE =
  /(キャンセル|取消|取り消し|cancell?ed?|cancellation)/i;
const RESERVATION_MODIFY_SHORT_RE = /(変更|修正|updated?)/i;
const RESERVATION_CANCEL_BODY_RE =
  /(?:(?:ご予約|予約内容?|ご来店予約|ネット予約)[^\n]{0,24}(?:が|は)?(?:キャンセル|取消|取り消し)(?:されました|となりました)?|(?:キャンセル|取消|取り消し)(?:されました|となりました|が入りました)|cancell?ed reservation|reservation cancellation)/i;
const RESERVATION_MODIFY_BODY_RE =
  /(?:(?:ご予約|予約内容?|ご来店予約|ネット予約)[^\n]{0,24}(?:が|は)?(?:変更|修正)(?:されました)?|(?:変更|修正)(?:されました|が入りました)|変更前|変更後|変更内容|予約日時[^\n]{0,12}変更|来店日時[^\n]{0,12}変更|updated reservation|reservation updated)/i;
const RESERVATION_DETAIL_KEYS: Array<keyof ReservationMailDetails> = [
  "reservationSite",
  "storeName",
  "reservationNo",
  "notificationNo",
  "vPointUsage",
  "visitDateTime",
  "partySize",
  "plan",
  "paymentMethod",
  "totalAmount",
  "seatName",
  "representativeName",
  "representativePhone",
  "allergy",
  "requestNote",
  "reservationHistory",
];

const TEST_RESERVATION_GMAIL_PREFIX = "cursor-test-reservation-";
const TEST_RESERVATION_CUSTOMER_NAME = "テスト太郎";
const TEST_RESERVATION_CUSTOMER_PHONE = "09011112222";

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const lineAccessToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
  const fallbackOverallRoomId = Deno.env.get("LINE_OVERALL_ROOM_ID") ?? "";

  if (!supabaseUrl || !supabaseKey) {
    return json({
      ok: false,
      error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.",
    }, 500);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const now = new Date();
  const jstHour = (now.getUTCHours() + 9) % 24;

  const url = new URL(req.url);
  if (url.searchParams.get("test_reservation") === "1") {
    if (!(await isGmailAlertTestAuthorized(req, supabaseKey))) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
    try {
      const roomOverride = String(url.searchParams.get("room_id") ?? "").trim();
      const result = await sendTestReservationLineNotification({
        supabase,
        now,
        jstHour,
        lineAccessToken,
        fallbackOverallRoomId,
        roomOverride,
      });
      return json(
        { ok: true, mode: "test_reservation", ...result },
        result.sent ? 200 : 400,
      );
    } catch (e) {
      console.error("Failed to send test reservation notification:", e);
      return json({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }, 500);
    }
  }

  // 定期実行(本処理)の認可: CRON_AUTH_TOKEN が設定されている場合のみ Bearer 一致を必須化する（フェイルクローズ）。
  // 未設定の間は従来どおり通す＝pg_cron(resolve_edge_cron_auth_token の Bearer)を壊さない。
  // 有効化手順: CRON_AUTH_TOKEN を vault（pg_cron 送信用）と Edge secret（この検証用）の両方に同値で設定する。
  const mainCronAuthToken = String(Deno.env.get("CRON_AUTH_TOKEN") ?? "")
    .trim();
  if (mainCronAuthToken) {
    const mainBearer = String(req.headers.get("Authorization") ?? "").replace(
      /^Bearer\s+/i,
      "",
    ).trim();
    if (!constantTimeEqual(mainBearer, mainCronAuthToken)) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
  }

  try {
    const result = await maybeSendGmailReservationAlerts({
      supabase,
      now,
      jstHour,
      lineAccessToken,
      fallbackOverallRoomId,
    });

    return json({
      ok: true,
      ...result,
    }, 200);
  } catch (e) {
    console.error("Failed to process Gmail reservation alerts:", e);
    return json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }, 500);
  }
});

async function isGmailAlertTestAuthorized(
  req: Request,
  serviceRoleKey: string,
): Promise<boolean> {
  const bearer = String(req.headers.get("Authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  ).trim();
  const sr = String(serviceRoleKey ?? "").trim();
  if (bearer && sr && constantTimeEqual(bearer, sr)) return true;

  const testSecret = String(
    Deno.env.get("GMAIL_ALERT_TEST_SECRET") ??
      Deno.env.get("CRON_AUTH_TOKEN") ?? "",
  ).trim();
  const headerKey = String(req.headers.get("x-gmail-alert-test-key") ?? "")
    .trim();
  if (testSecret && headerKey && constantTimeEqual(headerKey, testSecret)) {
    return true;
  }

  if (!bearer) return false;
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  if (!supabaseUrl) return false;
  const probe = createClient(supabaseUrl, bearer);
  const { error } = await probe.from("room_summary_settings").select("room_id")
    .limit(1);
  if (!error) return true;
  const msg = String(error.message ?? "");
  if (msg.includes("Invalid API key") || error.code === "PGRST301") {
    return false;
  }
  return true;
}

// 定数時間比較（秘密トークンの照合用・タイミング差で長さ/内容を漏らさない）
function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function testReservationVisitAtIso(
  year: number,
  month: number,
  day: number,
  hourJst: number,
  minuteJst: number,
): string {
  return new Date(Date.UTC(year, month - 1, day, hourJst - 9, minuteJst))
    .toISOString();
}

async function sendTestReservationLineNotification(params: {
  supabase: ReturnType<typeof createClient>;
  now: Date;
  jstHour: number;
  lineAccessToken: string;
  fallbackOverallRoomId: string;
  roomOverride: string;
}): Promise<Record<string, unknown>> {
  const {
    supabase,
    jstHour,
    lineAccessToken,
    fallbackOverallRoomId,
    roomOverride,
  } = params;

  if (!lineAccessToken) {
    return { sent: false, reason: "missing_line_channel_access_token" };
  }

  const fallbackTargetRoomId =
    String(Deno.env.get("LINE_GMAIL_ALERT_ROOM_ID") ?? "").trim() ||
    String(fallbackOverallRoomId ?? "").trim();
  let targetRoomIds = await resolveGmailAlertTargetRooms(
    supabase,
    fallbackTargetRoomId,
    { bypassThrottle: true },
  );
  if (roomOverride) {
    targetRoomIds = [{ roomId: roomOverride, storeKey: "" }];
  }
  if (targetRoomIds.length === 0) {
    return { sent: false, reason: "no_target_rooms" };
  }

  await cleanupTestReservationSeed(supabase);

  const seedRows: Array<{
    id: string;
    visitAt: string;
    reservationType: string;
    reservationDetail: string | null;
  }> = [
    {
      id: `${TEST_RESERVATION_GMAIL_PREFIX}past-1`,
      visitAt: testReservationVisitAtIso(2026, 3, 15, 18, 0),
      reservationType: "course",
      reservationDetail: "【テスト】過去予約1",
    },
    {
      id: `${TEST_RESERVATION_GMAIL_PREFIX}past-2`,
      visitAt: testReservationVisitAtIso(2026, 4, 20, 19, 30),
      reservationType: "course",
      reservationDetail: "【テスト】過去予約2",
    },
    {
      id: `${TEST_RESERVATION_GMAIL_PREFIX}past-cancel`,
      visitAt: testReservationVisitAtIso(2026, 5, 10, 19, 0),
      reservationType: "予約キャンセル",
      reservationDetail: "【テスト】キャンセル履歴",
    },
  ];

  for (const row of seedRows) {
    const { error } = await supabase.rpc("record_tabelog_reservation_visit", {
      p_gmail_message_id: row.id,
      p_customer_name: TEST_RESERVATION_CUSTOMER_NAME,
      p_customer_phone: TEST_RESERVATION_CUSTOMER_PHONE,
      p_visit_at: row.visitAt,
      p_reservation_type: row.reservationType,
      p_reservation_detail: row.reservationDetail,
    });
    if (error) {
      throw new Error(`seed failed (${row.id}): ${error.message}`);
    }
  }

  const currentMessageId =
    `${TEST_RESERVATION_GMAIL_PREFIX}current-${Date.now()}`;
  const mockAlert: GmailMessageAlert = {
    id: currentMessageId,
    threadId: null,
    subject: "【食べログ】ご予約のお知らせ（テスト送信）",
    from: "reservation@tabelog.com",
    snippet: "※これは履歴表示確認用のテスト通知です",
    internalDateIso: new Date().toISOString(),
    eventLabel: "新規予約",
    reservation: {
      reservationSite: "食べログ",
      storeName: "ビストロサヴァサヴァ（テスト）",
      reservationNo: "TEST-0001",
      notificationNo: null,
      vPointUsage: "なし",
      visitDateTime: "2026年05月30日(土) 19:00",
      partySize: "2名",
      plan: "【テスト】おまかせコース",
      paymentMethod: "現地決済",
      totalAmount: "¥8,800",
      seatName: "カウンター",
      representativeName: TEST_RESERVATION_CUSTOMER_NAME,
      representativePhone: TEST_RESERVATION_CUSTOMER_PHONE,
      allergy: "なし",
      requestNote: "テスト送信のため実予約ではありません",
      reservationHistory: null,
    },
    reservationExtractSource: "rule",
  };

  const enriched = await maybeAccumulatePartnerVisitHistory(
    supabase,
    mockAlert,
  );
  const linePayload = await buildGmailReservationAlertLinePayload(supabase, [
    enriched,
  ]);
  const successfulTargetRoomIds: string[] = [];
  const failedRooms: Array<{ room_id: string; error: string }> = [];

  for (const target of targetRoomIds) {
    const targetRoomId = target.roomId;
    const roomToken = resolveRoomLineToken(target.storeKey, lineAccessToken);
    const sendResult = await sendLineMessage(
      targetRoomId,
      linePayload,
      roomToken,
      target.storeKey,
    );
    if (!sendResult.ok) {
      failedRooms.push({
        room_id: targetRoomId,
        error: sendResult.error ?? "send_failed",
      });
      continue;
    }
    successfulTargetRoomIds.push(targetRoomId);
    await writeDeliveryLog(supabase, {
      jst_hour: jstHour,
      status: "gmail_alert_sent",
      reason: "Test reservation notification (cursor-test-reservation).",
      should_send_overall: false,
      rooms_targeted: 1,
      messages_in_queue: 0,
      messages_marked_processed: 0,
      line_send_attempted: true,
      line_send_success: true,
      line_http_status: sendResult.status ?? null,
      target_room_id: targetRoomId,
      details: {
        source: "gmail-alert-cron",
        test_reservation: true,
        customer_name: TEST_RESERVATION_CUSTOMER_NAME,
        customer_phone: TEST_RESERVATION_CUSTOMER_PHONE,
        gmail_message_id: currentMessageId,
        reservation_history: enriched.reservation?.reservationHistory ?? null,
      },
    });
  }

  if (successfulTargetRoomIds.length === 0) {
    return {
      sent: false,
      reason: "line_send_failed",
      target_rooms: targetRoomIds.map((t) => t.roomId),
      failed_rooms: failedRooms,
      reservation_history: enriched.reservation?.reservationHistory ?? null,
    };
  }

  return {
    sent: true,
    target_rooms: targetRoomIds,
    success_rooms: successfulTargetRoomIds,
    failed_rooms: failedRooms,
    customer_name: TEST_RESERVATION_CUSTOMER_NAME,
    customer_phone: TEST_RESERVATION_CUSTOMER_PHONE,
    gmail_message_id: currentMessageId,
    reservation_history: enriched.reservation?.reservationHistory ?? null,
  };
}

async function cleanupTestReservationSeed(
  supabase: ReturnType<typeof createClient>,
): Promise<void> {
  const likePattern = `${TEST_RESERVATION_GMAIL_PREFIX}%`;
  await supabase
    .from("reservation_customer_visit_history")
    .delete()
    .eq("partner", "tabelog")
    .like("gmail_message_id", likePattern);
  await supabase
    .from("tabelog_reservation_visit_events")
    .delete()
    .like("gmail_message_id", likePattern);
  await supabase
    .from("tabelog_reservation_visit_summaries")
    .delete()
    .eq("customer_name", TEST_RESERVATION_CUSTOMER_NAME)
    .eq("customer_phone", TEST_RESERVATION_CUSTOMER_PHONE);
}

async function maybeSendGmailReservationAlerts(params: {
  supabase: ReturnType<typeof createClient>;
  now: Date;
  jstHour: number;
  lineAccessToken: string;
  fallbackOverallRoomId: string;
}): Promise<Record<string, unknown>> {
  const {
    supabase,
    now,
    jstHour,
    lineAccessToken,
    fallbackOverallRoomId,
  } = params;

  const envState = loadGmailAlertEnv(fallbackOverallRoomId);
  if (!envState.ok) {
    return {
      skipped: true,
      reason: `missing_env: ${envState.missing.join(", ")}`,
    };
  }
  const env = envState.env;
  if (!env.enabled) {
    return { skipped: true, reason: "gmail_alert_disabled" };
  }
  if (!lineAccessToken) {
    return { skipped: true, reason: "missing_line_channel_access_token" };
  }

  const enabledTargets = await resolveGmailAlertTargetRooms(
    supabase,
    env.fallbackTargetRoomId,
    { now },
  );
  if (enabledTargets.length === 0) {
    return { skipped: true, reason: "no_target_rooms" };
  }

  const accessToken = await fetchGmailAccessTokenByRefreshToken(env);
  const primaryListedMessages = await listGmailMessages(
    accessToken,
    env.query,
    env.scanMessages,
  );
  const relaxedQuery = buildRelaxedGmailAlertQuery(env.query);
  let listedMessages = primaryListedMessages;
  let usedRelaxedQuery = false;

  if (listedMessages.length === 0 && relaxedQuery) {
    const relaxedListedMessages = await listGmailMessages(
      accessToken,
      relaxedQuery,
      env.scanMessages,
    );
    if (relaxedListedMessages.length > 0) {
      listedMessages = relaxedListedMessages;
      usedRelaxedQuery = true;
    }
  }

  if (listedMessages.length === 0) {
    return { skipped: true, reason: "no_matching_messages" };
  }

  let unnotifiedMessageIds = await filterUnnotifiedGmailMessageIds(
    supabase,
    listedMessages.map((message) => message.id),
  );
  unnotifiedMessageIds = unnotifiedMessageIds.slice(0, env.maxMessages);

  if (unnotifiedMessageIds.length === 0 && relaxedQuery && !usedRelaxedQuery) {
    const relaxedListedMessages = await listGmailMessages(
      accessToken,
      relaxedQuery,
      env.scanMessages,
    );
    if (relaxedListedMessages.length > 0) {
      listedMessages = mergeUniqueGmailMessageLists(
        listedMessages,
        relaxedListedMessages,
      );
      usedRelaxedQuery = true;
      unnotifiedMessageIds = await filterUnnotifiedGmailMessageIds(
        supabase,
        listedMessages.map((message) => message.id),
      );
      unnotifiedMessageIds = unnotifiedMessageIds.slice(0, env.maxMessages);
    }
  }

  if (unnotifiedMessageIds.length === 0) {
    return { skipped: true, reason: "already_notified" };
  }

  const unnotifiedSet = new Set(unnotifiedMessageIds);
  const messagesToFetch = listedMessages.filter((message) =>
    unnotifiedSet.has(message.id)
  );
  const alerts: GmailMessageAlert[] = [];
  const ignoredMessages: IgnoredGmailMessage[] = [];
  const extractSourceCounts: Record<string, number> = {
    rule: 0,
    ai: 0,
    rule_plus_ai: 0,
    none: 0,
  };

  for (const message of messagesToFetch) {
    const fetched = await fetchGmailMessageAlert(accessToken, message.id, env);
    if (!fetched) continue;
    if (fetched.kind === "ignored") {
      ignoredMessages.push(fetched.message);
      continue;
    }
    const enriched = await maybeAccumulatePartnerVisitHistory(
      supabase,
      fetched.alert,
    );
    alerts.push(enriched);
    extractSourceCounts[enriched.reservationExtractSource] =
      (extractSourceCounts[enriched.reservationExtractSource] ?? 0) + 1;
  }

  if (ignoredMessages.length > 0) {
    await saveIgnoredGmailMessages(supabase, ignoredMessages);
  }

  if (alerts.length === 0) {
    return {
      skipped: true,
      reason: "no_alert_payload",
      ignored_count: ignoredMessages.length,
    };
  }

  const deliveryBatches = planGmailAlertDeliveryBatches(alerts, enabledTargets);
  if (deliveryBatches.length === 0) {
    return {
      skipped: true,
      reason: "no_store_matched_target_rooms",
      alerts_count: alerts.length,
    };
  }

  const successfulTargetRoomIds = new Set<string>();
  const successfullyLoggedAlertIds = new Set<string>();
  const postedChatGroupIds = new Set<number>();

  for (const batch of deliveryBatches) {
    const linePayload = await buildGmailReservationAlertLinePayload(
      supabase,
      batch.alerts,
    );
    const batchSuccessfulRoomIds: string[] = [];
    const chatDedupeKey = batch.alerts.map((alert) => String(alert.id)).sort().join(",");
    const chatGroupId = await resolveChatGroupId(
      supabase,
      batch.targets[0]?.roomId ?? "",
    ) ?? await resolveChatGroupIdByStore(supabase, batch.storeKey);
    if (chatGroupId && !postedChatGroupIds.has(chatGroupId)) {
      const chatResult = await postChatCardIndependent(supabase, {
        groupId: chatGroupId,
        kind: "reservation_alert",
        dedupeKey: chatDedupeKey || `batch:${batch.batchKey}`,
        text: linePayload.text,
        cards: linePayload.chatCards,
      });
      if (!chatResult.ok) {
        console.error(
          `chat card post failed for store ${batch.storeKey}:`,
          chatResult.error,
        );
      } else if (!chatResult.skipped) {
        postedChatGroupIds.add(chatGroupId);
      }
    }

    for (const target of batch.targets) {
      const targetRoomId = target.roomId;
      const roomToken = resolveRoomLineToken(target.storeKey, lineAccessToken);
      const sendResult = await sendLineMessage(
        targetRoomId,
        linePayload,
        roomToken,
        target.storeKey,
      );
      if (!sendResult.ok) {
        await writeDeliveryLog(supabase, {
          jst_hour: jstHour,
          status: "gmail_alert_send_failed",
          reason: sendResult.error,
          should_send_overall: false,
          rooms_targeted: 1,
          messages_in_queue: 0,
          messages_marked_processed: 0,
          line_send_attempted: true,
          line_send_success: false,
          line_http_status: sendResult.status ?? null,
          target_room_id: targetRoomId,
          details: {
            gmail_query: env.query,
            gmail_relaxed_query_used: usedRelaxedQuery,
            gmail_relaxed_query: usedRelaxedQuery ? relaxedQuery : null,
            listed_primary_count: primaryListedMessages.length,
            listed_count: listedMessages.length,
            unnotified_count: batch.alerts.length,
            target_room_count: batch.targets.length,
            reservation_extract_counts: extractSourceCounts,
            gmail_ai_enabled: env.aiEnabled,
            source: "gmail-alert-cron",
            batch_key: batch.batchKey,
            store_key: batch.storeKey,
          },
        });
        continue;
      }

      batchSuccessfulRoomIds.push(targetRoomId);
      successfulTargetRoomIds.add(targetRoomId);
      // 配信間隔スロットリングの起点を更新（このルームの次回対象タイミングをここから数える）。
      await markGmailAlertRoomSent(supabase, targetRoomId, now.toISOString());
      await writeDeliveryLog(supabase, {
        jst_hour: jstHour,
        status: "gmail_alert_sent",
        reason: `Sent ${batch.alerts.length} reservation email alerts.`,
        should_send_overall: false,
        rooms_targeted: 1,
        messages_in_queue: 0,
        messages_marked_processed: 0,
        line_send_attempted: true,
        line_send_success: true,
        line_http_status: sendResult.status ?? null,
        target_room_id: targetRoomId,
        details: {
          gmail_query: env.query,
          gmail_relaxed_query_used: usedRelaxedQuery,
          gmail_relaxed_query: usedRelaxedQuery ? relaxedQuery : null,
          listed_primary_count: primaryListedMessages.length,
          listed_count: listedMessages.length,
          unnotified_count: batch.alerts.length,
          target_room_count: batch.targets.length,
          reservation_extract_counts: extractSourceCounts,
          gmail_ai_enabled: env.aiEnabled,
          source: "gmail-alert-cron",
          batch_key: batch.batchKey,
          store_key: batch.storeKey,
        },
      });
    }

    if (batchSuccessfulRoomIds.length > 0) {
      await saveGmailReservationAlertLogs(
        supabase,
        batch.alerts,
        batchSuccessfulRoomIds[0],
        now,
      );
      for (const alert of batch.alerts) {
        successfullyLoggedAlertIds.add(alert.id);
      }
    }
  }

  if (successfulTargetRoomIds.size === 0) {
    return {
      sent: false,
      alerts_count: alerts.length,
      target_rooms: deliveryBatches.reduce(
        (sum, batch) => sum + batch.targets.length,
        0,
      ),
      success_rooms: 0,
    };
  }

  return {
    sent: true,
    alerts_count: successfullyLoggedAlertIds.size,
    target_rooms: deliveryBatches.reduce(
      (sum, batch) => sum + batch.targets.length,
      0,
    ),
    success_rooms: successfulTargetRoomIds.size,
  };
}

function buildRelaxedGmailAlertQuery(query: string): string | null {
  const normalized = String(query ?? "").trim();
  if (!normalized) return null;

  const relaxed = normalized
    .replace(/(^|\s)is:unread(?=\s|$)/gi, " ")
    .replace(/(^|\s)label:unread(?=\s|$)/gi, " ")
    .replace(/(^|\s)is:inbox(?=\s|$)/gi, " ")
    .replace(/(^|\s)in:inbox(?=\s|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!relaxed || relaxed === normalized) return null;
  return relaxed;
}

function mergeUniqueGmailMessageLists(
  primary: GmailMessageListItem[],
  secondary: GmailMessageListItem[],
): GmailMessageListItem[] {
  const merged: GmailMessageListItem[] = [];
  const seen = new Set<string>();
  for (const row of [...primary, ...secondary]) {
    const id = String(row?.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push({
      id,
      threadId: String(row?.threadId ?? "").trim() || null,
    });
  }
  return merged;
}

async function maybeAccumulatePartnerVisitHistory(
  supabase: ReturnType<typeof createClient>,
  alert: GmailMessageAlert,
): Promise<GmailMessageAlert> {
  const route = formatReservationRouteLabel(
    alert.reservation?.reservationSite,
    alert.subject,
    alert.from,
    alert.snippet,
  );
  const historyConfig = resolvePartnerHistoryConfig(route);
  if (!historyConfig) return alert;

  const normalizedName = normalizeHistoryPersonName(
    alert.reservation?.representativeName,
  );
  const normalizedPhone = normalizeHistoryPhoneNumber(
    alert.reservation?.representativePhone,
  );
  if (!normalizedName || !normalizedPhone) return alert;

  const visitAtIso = parseHistoryVisitDateIso(
    alert.reservation?.visitDateTime,
    alert.internalDateIso,
  );
  const reservationType = inferReservationTypeLabel(
    alert.reservation?.plan,
    alert.reservation?.seatName,
  );
  const reservationDetail = buildReservationCalendarDetailPayload(alert, route);
  try {
    const { data, error } = await supabase.rpc(historyConfig.rpcName, {
      p_gmail_message_id: alert.id,
      p_customer_name: normalizedName,
      p_customer_phone: normalizedPhone,
      p_visit_at: visitAtIso,
      p_reservation_type: reservationType,
      p_reservation_detail: reservationDetail,
    });
    if (error) {
      console.error(
        `Failed to record ${historyConfig.partnerKey} reservation visit:`,
        error.message,
      );
      return alert;
    }

    const record = parseReservationVisitRecordResult(data);
    if (!record) return alert;
    const hasHistory = record.visit_count > 0 ||
      record.cancelled_count > 0 ||
      record.recent_visits.length > 0;
    if (!hasHistory) return alert;
    const historyParagraphs = buildReservationHistoryParagraphs(
      record,
      alert.reservation?.storeName ?? null,
    );
    const historyLabel = formatReservationHistoryForLine(
      record,
      historyParagraphs,
    );
    return {
      ...alert,
      reservation: {
        ...(alert.reservation ?? {
          reservationSite: route,
          storeName: null,
          reservationNo: null,
          notificationNo: null,
          vPointUsage: null,
          visitDateTime: null,
          partySize: null,
          plan: null,
          paymentMethod: null,
          totalAmount: null,
          seatName: null,
          representativeName: normalizedName,
          representativePhone: normalizedPhone,
          allergy: null,
          requestNote: null,
          reservationHistory: null,
          reservationHistoryParagraphs: null,
        }),
        reservationHistory: historyLabel,
        reservationHistoryParagraphs: historyParagraphs,
      },
    };
  } catch (err) {
    console.error(
      `Failed to record ${historyConfig.partnerKey} reservation visit:`,
      err,
    );
    return alert;
  }
}

function resolvePartnerHistoryConfig(
  routeLabel: string,
): { partnerKey: "tabelog" | "ikyu"; rpcName: string } | null {
  if (isTabelogReservationRoute(routeLabel)) {
    return {
      partnerKey: "tabelog",
      rpcName: "record_tabelog_reservation_visit",
    };
  }
  if (isIkyuReservationRoute(routeLabel)) {
    return { partnerKey: "ikyu", rpcName: "record_ikyu_reservation_visit" };
  }
  return null;
}

function parseReservationVisitRecordResult(
  data: unknown,
): ReservationVisitRecordResult | null {
  if (data == null) return null;
  if (typeof data === "number" && Number.isFinite(data)) {
    const visit_count = Math.max(0, Math.floor(data));
    return visit_count > 0
      ? { visit_count, cancelled_count: 0, recent_visits: [] }
      : null;
  }
  if (typeof data !== "object" || data === null) return null;
  const row = data as Record<string, unknown>;
  const visit_count = Math.max(0, Math.floor(Number(row.visit_count ?? 0)));
  const cancelled_count = Math.max(
    0,
    Math.floor(Number(row.cancelled_count ?? 0)),
  );
  const recentRaw = Array.isArray(row.recent_visits) ? row.recent_visits : [];
  const recent_visits = recentRaw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const rec = item as Record<string, unknown>;
      const visit_at = String(rec.visit_at ?? "").trim();
      if (!visit_at) return null;
      const store_name = String(rec.store_name ?? "").trim() || null;
      return {
        visit_at,
        is_cancelled: rec.is_cancelled === true,
        store_name,
      };
    })
    .filter((
      item,
    ): item is {
      visit_at: string;
      is_cancelled: boolean;
      store_name: string | null;
    } => item !== null)
    .slice(0, 5);
  if (visit_count <= 0 && cancelled_count <= 0 && recent_visits.length === 0) {
    return null;
  }
  return { visit_count, cancelled_count, recent_visits };
}

const RESERVATION_HISTORY_HEADING = "過去の予約";

function parseJapaneseCount(raw: string): number {
  const normalized = String(raw ?? "").replace(
    /[０-９]/g,
    (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30),
  );
  const n = Number.parseInt(normalized, 10);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function formatReservationCountLine(label: string, count: number): string {
  const digits = String(Math.max(0, Math.floor(count)))
    .replace(
      /[0-9]/g,
      (d) => String.fromCharCode(d.charCodeAt(0) - 0x30 + 0xff10),
    );
  return `${label}　${digits}回`;
}

function isReservationHistorySectionHeading(line: string): boolean {
  const trimmed = String(line ?? "").trim();
  return trimmed === RESERVATION_HISTORY_HEADING;
}

function buildReservationHistoryParagraphs(
  record: ReservationVisitRecordResult,
  currentStoreName?: string | null,
): string[] {
  const paragraphs: string[] = [
    formatReservationCountLine("予約回数", record.visit_count),
    formatReservationCountLine("キャンセル回数", record.cancelled_count),
  ];
  const dated = record.recent_visits
    .map((item) => {
      const label = formatReservationVisitAtLabel(item.visit_at);
      if (!label || label === "不明") return null;
      const suffixes: string[] = [];
      const historyStoreName = normalizeReservationHistoryStoreName(
        item.store_name,
      );
      if (
        shouldAnnotateReservationHistoryStore(
          historyStoreName,
          currentStoreName,
        )
      ) {
        suffixes.push(historyStoreName!);
      }
      if (item.is_cancelled) suffixes.push("キャンセル");
      return suffixes.length > 0 ? `${label}（${suffixes.join("・")}）` : label;
    })
    .filter((label): label is string => !!label);
  if (dated.length > 0) {
    paragraphs.push(RESERVATION_HISTORY_HEADING);
    for (const label of dated.slice(0, 5)) {
      paragraphs.push(label);
    }
  }
  return paragraphs;
}

function formatReservationHistoryForLine(
  record: ReservationVisitRecordResult,
  paragraphs = buildReservationHistoryParagraphs(record),
): string {
  return paragraphs.join("\n");
}

function formatReservationVisitAtLabel(
  visitAtIso: string | null | undefined,
): string {
  const iso = String(visitAtIso ?? "").trim();
  if (!iso) return "不明";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "不明";
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const pick = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const y = pick("year");
  const m = pick("month");
  const d = pick("day");
  const wd = pick("weekday");
  const hh = pick("hour");
  const mm = pick("minute");
  if (!y || !m || !d) return "不明";
  const timePart = hh && mm ? ` ${hh}:${mm}` : "";
  return `${y}/${m}/${d}(${wd})${timePart}`;
}

function normalizeReservationHistoryStoreName(
  value: string | null | undefined,
): string | null {
  const raw = String(value ?? "").trim();
  return raw || null;
}

function normalizeReservationHistoryStoreNameForCompare(
  value: string | null | undefined,
): string | null {
  const raw = normalizeReservationHistoryStoreName(value);
  if (!raw) return null;
  const stripped = raw.replace(/[（(].*?[）)]/g, "").replace(/[\s\u3000]+/g, "")
    .trim();
  return stripped || raw;
}

function resolveReservationHistoryStorePartitionKey(
  value: string | null | undefined,
): string | null {
  const raw = normalizeReservationHistoryStoreName(value);
  if (!raw) return null;
  const stripped = raw.replace(/[（(].*?[）)]/g, "").trim();
  const resolved = resolveReceiptNamePartitionKey(raw) ??
    resolveReceiptNamePartitionKey(stripped);
  return resolved ? String(resolved).trim() : null;
}

function shouldAnnotateReservationHistoryStore(
  historyStoreName: string | null | undefined,
  currentStoreName: string | null | undefined,
): boolean {
  const historyLabel = normalizeReservationHistoryStoreName(historyStoreName);
  if (!historyLabel) return false;
  const currentLabel = normalizeReservationHistoryStoreName(currentStoreName);
  if (!currentLabel) return true;

  const historyKey = resolveReservationHistoryStorePartitionKey(historyLabel);
  const currentKey = resolveReservationHistoryStorePartitionKey(currentLabel);
  if (historyKey && currentKey) {
    return !pilotStorePartitionKeysMatch(historyKey, currentKey);
  }

  const historyComparable = normalizeReservationHistoryStoreNameForCompare(
    historyLabel,
  );
  const currentComparable = normalizeReservationHistoryStoreNameForCompare(
    currentLabel,
  );
  if (historyComparable && currentComparable) {
    return historyComparable !== currentComparable;
  }
  return historyLabel !== currentLabel;
}

function normalizeHistoryPersonName(
  value: string | null | undefined,
): string | null {
  const normalized = normalizePersonName(value == null ? null : String(value));
  return normalized ? normalized.slice(0, 80) : null;
}

function normalizeHistoryPhoneNumber(
  value: string | null | undefined,
): string | null {
  const raw = normalizeInlineText(String(value ?? ""));
  if (!raw) return null;
  const zenkakuToHankaku = raw.replace(
    /[０-９]/g,
    (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
  const digits = zenkakuToHankaku.replace(/[^\d]/g, "");
  if (digits.length < 9) return null;
  return digits.slice(0, 20);
}

function parseHistoryVisitDateIso(
  value: string | null | undefined,
  fallbackIso: string | null,
): string | null {
  const parsed = parseReservationDateTime(
    normalizeInlineText(String(value ?? "")),
    fallbackIso,
  );
  if (!parsed) return fallbackIso;
  // Parsed values are JST-local reservation times; convert to UTC for storage.
  const iso = new Date(
    Date.UTC(
      parsed.year,
      parsed.month - 1,
      parsed.day,
      parsed.hour - 9,
      parsed.minute,
    ),
  ).toISOString();
  return iso;
}

function inferReservationTypeLabel(
  plan: string | null | undefined,
  seatName: string | null | undefined,
): string {
  const normalizedPlan = normalizeInlineText(String(plan ?? ""));
  if (
    normalizedPlan && normalizedPlan !== "不明" && normalizedPlan !== "なし"
  ) return "course";
  const normalizedSeat = normalizeInlineText(String(seatName ?? ""));
  if (
    normalizedSeat && normalizedSeat !== "不明" && normalizedSeat !== "なし"
  ) return "seat_only";
  return "unknown";
}

function buildReservationDetailLabel(
  plan: string | null | undefined,
  seatName: string | null | undefined,
): string | null {
  const normalizedPlan = normalizeInlineText(String(plan ?? ""));
  if (
    normalizedPlan && normalizedPlan !== "不明" && normalizedPlan !== "なし"
  ) return truncateForLine(normalizedPlan, 160);
  const normalizedSeat = normalizeInlineText(String(seatName ?? ""));
  if (
    normalizedSeat && normalizedSeat !== "不明" && normalizedSeat !== "なし"
  ) return truncateForLine(normalizedSeat, 160);
  return null;
}

function buildReservationCalendarDetailPayload(
  alert: GmailMessageAlert,
  routeLabel: string,
): string | null {
  const reservation = alert.reservation;
  const fallbackDetail = buildReservationDetailLabel(
    reservation?.plan,
    reservation?.seatName,
  );
  const route = normalizeCalendarDetailText(routeLabel, 80);
  const reservationSite = normalizeCalendarDetailText(
    reservation?.reservationSite,
    80,
  );
  const customerName = normalizeCalendarDetailText(
    normalizeHistoryPersonName(reservation?.representativeName),
    80,
  );
  const visitDateTime = normalizeCalendarDetailText(
    reservation?.visitDateTime,
    100,
  );
  const plan = normalizeCalendarDetailText(reservation?.plan, 180);
  const partySize = normalizeCalendarPartySize(reservation?.partySize);
  const allergy = normalizeCalendarAllergy(reservation?.allergy);
  const storeName = normalizeCalendarDetailText(reservation?.storeName, 90);
  // 予約番号: 予約変更時に「元の予約」を照合するための安定キー（通知番号は通知ごとに変わるので使わない）。
  const reservationNo = normalizeCalendarDetailText(
    reservation?.reservationNo,
    60,
  );
  // キャンセル/変更の種別を detail JSON に載せる。これにより DB 側 reservation_visit_looks_cancelled が
  // キャンセルを検知して visit_count を -1、reservation_visit_looks_modified が変更を検知して
  // 来店回数を据え置き＋元予約を上書きできる（種別が無いと +1 のまま減算/据え置きされない）。
  const eventLabel = alert.eventLabel;
  const eventType = eventLabel && eventLabel !== "新規予約" ? eventLabel : null;

  const payload = {
    v: 1,
    source: isTabelogReservationRoute(routeLabel)
      ? "tabelog"
      : (isIkyuReservationRoute(routeLabel) ? "ikyu" : null),
    route,
    reservationSite,
    customerName,
    visitDateTime,
    plan,
    partySize,
    allergy,
    storeName,
    reservationNo,
    eventType,
  };
  const hasAnyField = Object.values(payload).some((value) =>
    typeof value === "string" && value.length > 0
  );
  if (!hasAnyField) return fallbackDetail;

  try {
    return JSON.stringify(payload);
  } catch {
    return fallbackDetail;
  }
}

function normalizeCalendarDetailText(
  raw: string | null | undefined,
  maxLength: number,
): string | null {
  const normalized = normalizeInlineText(String(raw ?? ""));
  if (!normalized) return null;
  if (normalized === "不明" || normalized === "なし") return null;
  if (normalized.length > maxLength) {
    return `${normalized.slice(0, maxLength)}...`;
  }
  return normalized;
}

function normalizeCalendarPartySize(
  raw: string | null | undefined,
): string | null {
  return normalizePartySizeLabel(raw == null ? null : String(raw));
}

function normalizeCalendarAllergy(
  raw: string | null | undefined,
): string | null {
  return normalizeAllergyAnswer(raw == null ? null : String(raw));
}

// 予約通知の送信先（ルームIDと、その店舗キー）。店舗キーから店舗別LINEトークンを解決する。
type GmailAlertTarget = { roomId: string; storeKey: string };

// 店舗別チャネルトークン解決（_shared/line_client.ts の resolveChannelAccessToken と同一ロジック）。
// 店舗別 LINE_CHANNEL_ACCESS_TOKEN__<STORE> があればそれを、無ければ呼び出し元のフォールバック（=グローバル）を使う。
// これにより予約通知が各店舗の公式アカウント（＝月200通枠が店舗ごとに独立）から送られ、共有アカウントへの集中を防ぐ。
// LINEアクセストークンをHTTPヘッダに安全な形へ正規化する。
// 印字可能ASCII(0x21-0x7e、空白を除く)以外（改行・空白・タブ・全角・制御文字など）を除去。
// シークレット設定時にトークンへ紛れ込んだ不正文字で
// "Failed to construct 'Request': ... is not a valid ByteString" になるのを防ぐ。
function sanitizeLineToken(raw: unknown): string {
  return String(raw ?? "").replace(/[^\x21-\x7e]/g, "");
}

function resolveRoomLineToken(storeKey: string, fallbackToken: string): string {
  const key = String(storeKey ?? "").trim();
  if (key) {
    const suffix = key.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase();
    // 予約通知の一時流用（別アカウント）。月200通上限の一時回避用。レシート等(resolveChannelAccessToken)には影響しない。
    // 来月にこれらのシークレットを削除すれば自動で店舗本来のアカウントへ戻る。
    //  (1) 生トークン指定: LINE_RESERVATION_ALERT_TOKEN__<STORE> に別アカウントのアクセストークン。
    const override = sanitizeLineToken(
      Deno.env.get(`LINE_RESERVATION_ALERT_TOKEN__${suffix}`),
    );
    if (override) return override;
    //  (2) 借りる店舗キー指定: LINE_RESERVATION_ALERT_BORROW__<STORE> = 別店舗キー（例: claudia2）。
    //      → その店舗の既存 LINE_CHANNEL_ACCESS_TOKEN__<別店舗> を使う（トークンのコピー不要）。
    const borrow = String(
      Deno.env.get(`LINE_RESERVATION_ALERT_BORROW__${suffix}`) ?? "",
    ).trim();
    if (borrow) {
      const bSuffix = borrow.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase();
      const borrowed = sanitizeLineToken(
        Deno.env.get(`LINE_CHANNEL_ACCESS_TOKEN__${bSuffix}`),
      );
      if (borrowed) return borrowed;
    }
    const perStore = sanitizeLineToken(
      Deno.env.get(`LINE_CHANNEL_ACCESS_TOKEN__${suffix}`),
    );
    if (perStore) return perStore;
  }
  return sanitizeLineToken(fallbackToken);
}

async function resolveGmailAlertTargetRooms(
  supabase: ReturnType<typeof createClient>,
  fallbackTargetRoomId: string,
  opts: { now?: Date; bypassThrottle?: boolean } = {},
): Promise<GmailAlertTarget[]> {
  const { data, error } = await supabase
    .from("room_summary_settings")
    .select(
      "room_id, is_enabled, gmail_reservation_alert_enabled, receipt_report_store_partition_key, room_name, gmail_alert_interval_minutes, gmail_alert_anchor_hour, gmail_alert_anchor_minute",
    );

  if (error) {
    console.error(
      "Failed to fetch room settings for Gmail alert targets:",
      error.message,
    );
    const fallback = String(fallbackTargetRoomId ?? "").trim();
    return fallback ? [{ roomId: fallback, storeKey: "" }] : [];
  }

  const now = opts.now ?? new Date();
  const bypassThrottle = opts.bypassThrottle === true;

  const rows = Array.isArray(data) ? data : [];
  const seen = new Set<string>();
  const targets: GmailAlertTarget[] = [];
  for (const row of rows) {
    const r = row as any;
    if (
      r?.is_enabled === false || r?.gmail_reservation_alert_enabled !== true
    ) continue;
    const roomId = String(r?.room_id ?? "").trim();
    if (!roomId || seen.has(roomId)) continue;
    seen.add(roomId);

    // NULL/1=毎分のリアルタイム通知。まとめ配信は「最後に送った時刻」ではなく、
    // JST の基準時刻を起点にした固定スロットで判定する。
    // 例: 基準10:00・12時間ごとなら、毎日10:00と22:00にだけ送る。
    if (!bypassThrottle) {
      const intervalMinutes = r?.gmail_alert_interval_minutes != null
        ? Number(r.gmail_alert_interval_minutes)
        : 1;
      if (Number.isFinite(intervalMinutes) && intervalMinutes > 1) {
        const anchorHour = r?.gmail_alert_anchor_hour != null && Number.isInteger(Number(r.gmail_alert_anchor_hour))
          ? Number(r.gmail_alert_anchor_hour)
          : 10;
        const anchorMinute = r?.gmail_alert_anchor_minute != null && Number.isInteger(Number(r.gmail_alert_anchor_minute))
          ? Number(r.gmail_alert_anchor_minute)
          : 0;
        const jst = new Date(now.getTime() + 9 * 60 * 60_000);
        const minuteOfDay = jst.getUTCHours() * 60 + jst.getUTCMinutes();
        const anchorMinuteOfDay = anchorHour * 60 + anchorMinute;
        if (minuteOfDay < anchorMinuteOfDay || (minuteOfDay - anchorMinuteOfDay) % intervalMinutes !== 0) continue;
      }
    }

    let storeKey = String(r?.receipt_report_store_partition_key ?? "").trim();
    if (!storeKey) {
      const resolved = await resolveStorePartitionKeyForRoom(supabase, roomId);
      storeKey = String(resolved ?? "").trim();
    }



    targets.push({
      roomId,
      storeKey,
    });
  }

  if (targets.length > 0) return targets;
  if (rows.length > 0) return [];

  const fallback = String(fallbackTargetRoomId ?? "").trim();
  return fallback ? [{ roomId: fallback, storeKey: "" }] : [];
}

// このルームへ実際に配信できた時刻を記録する（配信間隔スロットリングの起点。best-effort）。
async function markGmailAlertRoomSent(
  supabase: ReturnType<typeof createClient>,
  roomId: string,
  sentAtIso: string,
): Promise<void> {
  try {
    const { error } = await supabase
      .from("room_summary_settings")
      .update({ gmail_alert_last_sent_at: sentAtIso })
      .eq("room_id", roomId);
    if (error) {
      console.error("markGmailAlertRoomSent failed:", error.message);
    }
  } catch (e) {
    console.error(
      "markGmailAlertRoomSent threw:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

function planGmailAlertDeliveryBatches(
  alerts: GmailMessageAlert[],
  enabledTargets: GmailAlertTarget[],
): GmailAlertDeliveryBatch[] {
  const batches = new Map<string, GmailAlertDeliveryBatch>();
  const storeScopedTargets = enabledTargets.filter((target) =>
    String(target.storeKey ?? "").trim()
  );
  const fallbackTargets = enabledTargets.filter((target) =>
    !String(target.storeKey ?? "").trim()
  );

  for (const alert of Array.isArray(alerts) ? alerts : []) {
    const resolvedStoreKey = resolveAlertStorePartitionKey(alert);
    const matchedTargets = resolvedStoreKey
      ? storeScopedTargets.filter((target) =>
        pilotStorePartitionKeysMatch(target.storeKey, resolvedStoreKey)
      )
      : [];
    const targets = matchedTargets.length > 0
      ? matchedTargets
      : fallbackTargets;
    if (targets.length === 0) continue;

    const batchKey = matchedTargets.length > 0
      ? `store:${resolvedStoreKey}`
      : `fallback:${resolvedStoreKey ?? "unknown"}`;
    const existing = batches.get(batchKey);
    if (existing) {
      existing.alerts.push(alert);
      continue;
    }
    batches.set(batchKey, {
      batchKey,
      storeKey: matchedTargets.length > 0 ? resolvedStoreKey : null,
      alerts: [alert],
      targets,
    });
  }

  return Array.from(batches.values());
}

function loadGmailAlertEnv(fallbackOverallRoomId: string): GmailAlertEnvState {
  const clientId = String(Deno.env.get("GMAIL_CLIENT_ID") ?? "").trim();
  const clientSecret = String(Deno.env.get("GMAIL_CLIENT_SECRET") ?? "").trim();
  const refreshToken = String(Deno.env.get("GMAIL_REFRESH_TOKEN") ?? "").trim();
  // 環境変数で query が設定されていても is:unread を強制的に外す（既読の予約も拾う）。
  const rawQuery = String(Deno.env.get("GMAIL_ALERT_QUERY") ?? "").trim() ||
    DEFAULT_GMAIL_ALERT_QUERY;
  const query = rawQuery
    .replace(/(^|\s)is:unread(?=\s|$)/gi, " ")
    .replace(/(^|\s)label:unread(?=\s|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim() || DEFAULT_GMAIL_ALERT_QUERY;
  const fallbackTargetRoomId =
    String(Deno.env.get("LINE_GMAIL_ALERT_ROOM_ID") ?? "").trim() ||
    String(fallbackOverallRoomId ?? "").trim();
  const aiApiKey = String(Deno.env.get("GROQ_API_KEY") ?? "").trim();
  const aiEnabled = parseBooleanEnv(
    Deno.env.get("GMAIL_ALERT_AI_ENABLED"),
    !!aiApiKey,
  );
  const rawAiMaxChars = Number(
    Deno.env.get("GMAIL_ALERT_AI_MAX_BODY_CHARS") ??
      DEFAULT_GMAIL_ALERT_AI_MAX_BODY_CHARS,
  );
  const aiMaxBodyChars = Number.isInteger(rawAiMaxChars) &&
      rawAiMaxChars >= MIN_GMAIL_ALERT_AI_MAX_BODY_CHARS &&
      rawAiMaxChars <= MAX_GMAIL_ALERT_AI_MAX_BODY_CHARS
    ? rawAiMaxChars
    : DEFAULT_GMAIL_ALERT_AI_MAX_BODY_CHARS;

  const hasAnyCredential = !!clientId || !!clientSecret || !!refreshToken;
  const enabled = parseBooleanEnv(
    Deno.env.get("GMAIL_ALERT_ENABLED"),
    hasAnyCredential,
  );
  const rawMaxMessages = Number(
    Deno.env.get("GMAIL_ALERT_MAX_MESSAGES") ??
      DEFAULT_GMAIL_ALERT_MAX_MESSAGES,
  );
  const maxMessages = Number.isInteger(rawMaxMessages) &&
      rawMaxMessages >= 1 &&
      rawMaxMessages <= MAX_GMAIL_ALERT_MAX_MESSAGES
    ? rawMaxMessages
    : DEFAULT_GMAIL_ALERT_MAX_MESSAGES;
  const rawScanMessages = Number(
    Deno.env.get("GMAIL_ALERT_SCAN_MESSAGES") ??
      DEFAULT_GMAIL_ALERT_SCAN_MESSAGES,
  );
  const scanMessages = Number.isInteger(rawScanMessages) &&
      rawScanMessages >= maxMessages &&
      rawScanMessages <= MAX_GMAIL_ALERT_SCAN_MESSAGES
    ? rawScanMessages
    : DEFAULT_GMAIL_ALERT_SCAN_MESSAGES;

  if (!enabled) {
    return {
      ok: true,
      env: {
        enabled: false,
        clientId,
        clientSecret,
        refreshToken,
        query,
        maxMessages,
        scanMessages,
        fallbackTargetRoomId,
        aiEnabled,
        aiApiKey,
        aiMaxBodyChars,
      },
    };
  }

  const missing: string[] = [];
  if (!clientId) missing.push("GMAIL_CLIENT_ID");
  if (!clientSecret) missing.push("GMAIL_CLIENT_SECRET");
  if (!refreshToken) missing.push("GMAIL_REFRESH_TOKEN");
  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    env: {
      enabled: true,
      clientId,
      clientSecret,
      refreshToken,
      query,
      maxMessages,
      scanMessages,
      fallbackTargetRoomId,
      aiEnabled,
      aiApiKey,
      aiMaxBodyChars,
    },
  };
}

async function fetchGmailAccessTokenByRefreshToken(
  env: GmailAlertEnv,
): Promise<string> {
  const body = new URLSearchParams();
  body.set("client_id", env.clientId);
  body.set("client_secret", env.clientSecret);
  body.set("refresh_token", env.refreshToken);
  body.set("grant_type", "refresh_token");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Gmail OAuth token request failed (${response.status}): ${text}`,
    );
  }

  const json = await response.json();
  const accessToken = String(json?.access_token ?? "");
  if (!accessToken) {
    throw new Error("Gmail OAuth token response missing access_token.");
  }
  return accessToken;
}

async function listGmailMessages(
  accessToken: string,
  query: string,
  maxMessages: number,
): Promise<GmailMessageListItem[]> {
  const url = new URL(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages",
  );
  url.searchParams.set("maxResults", String(maxMessages));
  url.searchParams.set("includeSpamTrash", "false");
  if (query) {
    url.searchParams.set("q", query);
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gmail messages.list failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const rows = Array.isArray(data?.messages) ? data.messages : [];
  return rows
    .map((row: any) => ({
      id: String(row?.id ?? "").trim(),
      threadId: String(row?.threadId ?? "").trim() || null,
    }))
    .filter((row: GmailMessageListItem) => row.id.length > 0);
}

async function filterUnnotifiedGmailMessageIds(
  supabase: ReturnType<typeof createClient>,
  messageIds: string[],
): Promise<string[]> {
  if (messageIds.length === 0) {
    return [];
  }

  const uniqueIds = Array.from(
    new Set(
      messageIds.map((value) => String(value ?? "").trim()).filter((value) =>
        value.length > 0
      ),
    ),
  );
  if (uniqueIds.length === 0) {
    return [];
  }

  const [sentResult, ignoredResult] = await Promise.all([
    supabase
      .from("gmail_reservation_alert_logs")
      .select("gmail_message_id")
      .in("gmail_message_id", uniqueIds),
    supabase
      .from("gmail_reservation_ignored_messages")
      .select("gmail_message_id")
      .in("gmail_message_id", uniqueIds),
  ]);

  if (sentResult.error) {
    throw new Error(
      `Failed to query Gmail alert log table: ${sentResult.error.message}`,
    );
  }
  if (ignoredResult.error) {
    throw new Error(
      `Failed to query ignored Gmail message table: ${ignoredResult.error.message}`,
    );
  }

  const existing = new Set<string>(
    [
      ...(Array.isArray(sentResult.data) ? sentResult.data : []),
      ...(Array.isArray(ignoredResult.data) ? ignoredResult.data : []),
    ]
      .map((row: any) => String(row?.gmail_message_id ?? "").trim())
      .filter((value: string) => value.length > 0),
  );
  return uniqueIds.filter((id) => !existing.has(id));
}

async function fetchGmailMessageAlert(
  accessToken: string,
  messageId: string,
  env: GmailAlertEnv,
): Promise<GmailMessageFetchResult | null> {
  const normalizedMessageId = String(messageId ?? "").trim();
  if (!normalizedMessageId) {
    return null;
  }

  const url = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${
      encodeURIComponent(normalizedMessageId)
    }`,
  );
  url.searchParams.set("format", "full");
  url.searchParams.append("metadataHeaders", "Subject");
  url.searchParams.append("metadataHeaders", "From");
  url.searchParams.append("metadataHeaders", "Date");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gmail messages.get failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const payloadHeaders = Array.isArray(data?.payload?.headers)
    ? data.payload.headers
    : [];
  const subject =
    normalizeInlineText(extractGmailHeader(payloadHeaders, "subject")) ||
    "(件名なし)";
  const from =
    normalizeInlineText(extractGmailHeader(payloadHeaders, "from")) ||
    "(送信元不明)";
  const bodyText = extractGmailBodyText(data?.payload);
  const snippet = normalizeInlineText(String(data?.snippet ?? ""));
  const internalDateMs = Number(data?.internalDate);
  const internalDateIso = Number.isFinite(internalDateMs) && internalDateMs > 0
    ? new Date(internalDateMs).toISOString()
    : null;
  const route = inferReservationSite(subject, from, bodyText);
  if (!isSupportedReservationRoute(route)) {
    return {
      kind: "ignored",
      message: {
        id: String(data?.id ?? normalizedMessageId),
        threadId: String(data?.threadId ?? "").trim() || null,
        subject,
        from,
        internalDateIso,
        reason: "unsupported_route",
      },
    };
  }
  if (!isLikelyReservationNotificationMail(subject, snippet, bodyText)) {
    return {
      kind: "ignored",
      message: {
        id: String(data?.id ?? normalizedMessageId),
        threadId: String(data?.threadId ?? "").trim() || null,
        subject,
        from,
        internalDateIso,
        reason: "non_reservation_notification",
      },
    };
  }
  const reservationByRule = extractReservationMailDetails(
    subject,
    bodyText,
    from,
    internalDateIso,
  );
  let reservation = reservationByRule;
  let reservationExtractSource: GmailMessageAlert["reservationExtractSource"] =
    reservationByRule ? "rule" : "none";

  if (
    env.aiEnabled && env.aiApiKey &&
    shouldUseAiReservationExtraction(reservationByRule)
  ) {
    const reservationByAi = await extractReservationMailDetailsWithGroq({
      subject,
      bodyText,
      apiKey: env.aiApiKey,
      maxBodyChars: env.aiMaxBodyChars,
    });
    if (reservationByAi) {
      if (reservationByRule) {
        const merged = mergeReservationMailDetails(
          reservationByRule,
          reservationByAi,
        );
        reservation = merged ?? reservationByRule;
        reservationExtractSource = "rule_plus_ai";
      } else {
        reservation = reservationByAi;
        reservationExtractSource = "ai";
      }
    }
  }
  const eventLabel = inferReservationEventLabel({
    subject,
    snippet,
    bodyText,
  });

  return {
    kind: "alert",
    alert: {
      id: String(data?.id ?? normalizedMessageId),
      threadId: String(data?.threadId ?? "").trim() || null,
      subject,
      from,
      snippet,
      internalDateIso,
      eventLabel,
      reservation,
      reservationExtractSource,
    },
  };
}

function extractGmailHeader(
  headers: Array<{ name?: string; value?: string }>,
  headerName: string,
): string {
  const target = headerName.toLowerCase();
  for (const header of headers) {
    const name = String(header?.name ?? "").trim().toLowerCase();
    if (name !== target) continue;
    return String(header?.value ?? "");
  }
  return "";
}

async function buildGmailReservationAlertLinePayload(
  supabase: ReturnType<typeof createClient>,
  alerts: GmailMessageAlert[],
): Promise<LineMessagePayload> {
  const text = buildGmailReservationAlertMessage(alerts);
  const calendarUrls = await buildReservationCalendarUrlsForAlerts(
    supabase,
    alerts,
  );
  return {
    text,
    richMessages: buildGmailReservationFlexMessages(alerts, calendarUrls),
    chatCards: buildGmailReservationChatCards(alerts, calendarUrls),
  };
}

/**
 * Flex のバブル1つ = カード1枚として組み直す。
 * カルーセルは chat.html 側で縦に積むので、1通のメッセージにまとめて入れる。
 */
function buildGmailReservationChatCards(
  alerts: GmailMessageAlert[],
  calendarUrls?: Map<string, string>,
): ChatCard[] {
  const list = Array.isArray(alerts) ? alerts : [];
  if (list.length === 0) return [];

  const total = list.length;
  return list.slice(0, GMAIL_ALERT_FLEX_MAX_BUBBLES).map((alert, index) => {
    const template = buildReservationTemplateData(alert);
    const calendarUrl = calendarUrls?.get(alert.id) ?? null;
    return {
      header: {
        eyebrow: total > 1 ? `${index + 1}/${total}` : "予約通知",
        title: `【${template.eventLabel}】`,
        subtitle: template.fields.find((f) => f.label === "店舗")?.value ?? null,
      },
      sections: [{
        type: "fields" as const,
        rows: template.fields.map((field) => ({
          label: field.label,
          value: field.value,
          paragraphs: field.valueParagraphs?.length ? field.valueParagraphs : undefined,
        })),
      }],
      action: calendarUrl ? { label: "予約カレンダーを開く", url: calendarUrl } : null,
    };
  });
}

function buildGmailReservationAlertMessage(
  alerts: GmailMessageAlert[],
): string {
  const lines: string[] = [`【予約メール通知】新着${alerts.length}件`];
  for (let i = 0; i < alerts.length; i += 1) {
    const template = buildReservationTemplateData(alerts[i]);
    lines.push("");
    if (alerts.length > 1) {
      lines.push(`(${i + 1}/${alerts.length})`);
    }
    lines.push(`【${template.eventLabel}】`);
    for (const field of template.fields) {
      const displayValue = field.valueParagraphs?.length
        ? field.valueParagraphs.join("\n\n")
        : field.value;
      lines.push(
        formatAlignedReservationLine(
          field.label,
          displayValue,
          field.label === "コース"
            ? RESERVATION_TEMPLATE_COURSE_VALUE_WRAP_WIDTH
            : RESERVATION_TEMPLATE_DEFAULT_VALUE_WRAP_WIDTH,
        ),
      );
    }
  }
  return lines.join("\n").slice(0, 4900);
}

type ReservationTemplateField = {
  label: string;
  value: string;
  /** Flex の予約回数・履歴欄: 1行＝1段落として縦に並べる */
  valueParagraphs?: string[];
};

function buildReservationTemplateData(alert: GmailMessageAlert): {
  eventLabel: string;
  fields: ReservationTemplateField[];
} {
  const reservation = alert.reservation;
  const eventLabel = alert.eventLabel;
  const routeLabel = formatReservationRouteLabel(
    reservation?.reservationSite,
    alert.subject,
    alert.from,
    alert.snippet,
  );
  const isTabelogRoute = isTabelogReservationRoute(routeLabel);
  const storeLabel = fallbackField(reservation?.storeName, "不明");
  const dateTimeLabel = formatReservationDateTimeLabel(
    reservation?.visitDateTime,
    alert.internalDateIso,
  );
  const partySizeLabel = formatReservationPartySizeLabel(
    reservation?.partySize,
  );
  const representativeLabel = formatReservationPersonNameLabel(
    reservation?.representativeName,
  );
  const phoneLabel = fallbackField(reservation?.representativePhone, "不明");
  const planLabel = fallbackField(reservation?.plan, "不明");
  const amountLabel = fallbackField(reservation?.totalAmount, "不明");
  const vPointUsageLabel = formatVPointUsageLabel(
    reservation?.vPointUsage,
    isTabelogRoute,
  );
  const seatLabel = fallbackField(reservation?.seatName, "不明");
  const allergyLabel = fallbackField(reservation?.allergy, "なし");
  const requestLabel = fallbackField(reservation?.requestNote, "なし");
  const reservationNoLabel = fallbackField(
    reservation?.reservationNo ?? reservation?.notificationNo,
    "不明",
  );
  const historyLabel = fallbackField(reservation?.reservationHistory, "不明");
  const reservationCountLabel = formatReservationHistoryDisplay(
    historyLabel,
    isTabelogRoute,
  );
  const reservationHistoryParagraphs =
    Array.isArray(reservation?.reservationHistoryParagraphs) &&
      reservation.reservationHistoryParagraphs.length > 0
      ? reservation.reservationHistoryParagraphs
      : parseReservationHistoryParagraphs(reservationCountLabel);

  const fields: ReservationTemplateField[] = [
    { label: "経路", value: truncateForLine(routeLabel, 90) },
    { label: "店舗", value: truncateForLine(storeLabel, 90) },
    { label: "日時", value: truncateForLine(dateTimeLabel, 80) },
    { label: "人数", value: truncateForLine(partySizeLabel, 24) },
    { label: "予約者", value: truncateForLine(representativeLabel, 40) },
    { label: "TEL", value: truncateForLine(phoneLabel, 30) },
    { label: "コース", value: truncateForLine(planLabel, 120) },
    { label: "金額", value: truncateForLine(amountLabel, 60) },
  ];

  if (vPointUsageLabel) {
    fields.push({
      label: "Vポイント",
      value: truncateForLine(vPointUsageLabel, 40),
    });
  }

  fields.push(
    { label: "席", value: truncateForLine(seatLabel, 100) },
    { label: "アレルギー", value: truncateForLine(allergyLabel, 80) },
    { label: "要望", value: truncateForLine(requestLabel, 80) },
  );

  if (isTabelogRoute) {
    fields.push({
      label: "予約回数",
      value: truncateForLinePreserveBreaks(reservationCountLabel, 320),
      valueParagraphs: reservationHistoryParagraphs,
    });
  } else {
    fields.push(
      { label: "予約番号", value: truncateForLine(reservationNoLabel, 60) },
      {
        label: "履歴",
        value: truncateForLinePreserveBreaks(reservationCountLabel, 320),
        valueParagraphs: reservationHistoryParagraphs,
      },
    );
  }

  return {
    eventLabel,
    fields,
  };
}

const RESERVATION_TEMPLATE_LABEL_WIDTH = 12;
const RESERVATION_TEMPLATE_DEFAULT_VALUE_WRAP_WIDTH = 24;
const RESERVATION_TEMPLATE_COURSE_VALUE_WRAP_WIDTH = 20;
const GMAIL_ALERT_FLEX_MAX_BUBBLES = 12;

function buildGmailReservationFlexMessages(
  alerts: GmailMessageAlert[],
  calendarUrls?: Map<string, string>,
): Array<Record<string, unknown>> {
  const flex = buildGmailReservationFlexMessage(alerts, calendarUrls);
  return flex ? [flex] : [];
}

function buildGmailReservationFlexMessage(
  alerts: GmailMessageAlert[],
  calendarUrls?: Map<string, string>,
): Record<string, unknown> | null {
  const list = Array.isArray(alerts) ? alerts : [];
  if (list.length === 0) return null;

  const totalCount = list.length;
  const limited = list.slice(0, GMAIL_ALERT_FLEX_MAX_BUBBLES);
  const bubbles = limited.map((alert, index) =>
    buildGmailReservationFlexBubble(
      alert,
      index + 1,
      totalCount,
      calendarUrls?.get(alert.id) ?? null,
    )
  );

  return {
    type: "flex",
    altText: buildGmailReservationFlexAltText(list),
    contents: bubbles.length === 1 ? bubbles[0] : {
      type: "carousel",
      contents: bubbles,
    },
  };
}

function buildGmailReservationFlexAltText(alerts: GmailMessageAlert[]): string {
  const first = alerts[0];
  const template = first ? buildReservationTemplateData(first) : null;
  const store =
    template?.fields.find((field) => field.label === "店舗")?.value ?? "不明";
  return truncateForLine(
    `予約メール通知 新着${alerts.length}件 / ${
      template?.eventLabel ?? "新規予約"
    } / ${store}`,
    350,
  );
}

function buildGmailReservationFlexBubble(
  alert: GmailMessageAlert,
  index: number,
  total: number,
  calendarUrl: string | null,
): Record<string, unknown> {
  const template = buildReservationTemplateData(alert);
  const rows = template.fields.map((field) => {
    if (
      isReservationHistoryFlexField(field.label) && field.valueParagraphs &&
      field.valueParagraphs.length > 0
    ) {
      return buildGmailReservationFlexParagraphRow(
        field.label,
        field.valueParagraphs,
      );
    }
    return buildGmailReservationFlexRow(field.label, field.value);
  });

  const bubble: Record<string, unknown> = {
    type: "bubble",
    size: "mega",
    header: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      paddingAll: "14px",
      contents: [
        {
          type: "text",
          text: total > 1 ? `${index}/${total}` : "予約通知",
          size: "xs",
          color: "#6b7280",
        },
        {
          type: "text",
          text: `【${template.eventLabel}】`,
          size: "lg",
          weight: "bold",
          wrap: true,
          color: "#111827",
        },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      paddingAll: "14px",
      contents: rows,
    },
  };

  if (calendarUrl) {
    bubble.footer = {
      type: "box",
      layout: "vertical",
      paddingAll: "12px",
      contents: [
        {
          type: "button",
          style: "primary",
          height: "sm",
          action: {
            type: "uri",
            label: "予約カレンダーを開く",
            uri: calendarUrl,
          },
        },
      ],
    };
  }

  return bubble;
}

function resolveAlertStorePartitionKey(
  alert: GmailMessageAlert,
): string | null {
  const storeName = String(alert?.reservation?.storeName ?? "").trim();
  if (!storeName) return null;
  const resolved = resolveReceiptNamePartitionKey(storeName) ??
    resolveReceiptNamePartitionKey(
      storeName.replace(/[（(].*?[）)]/g, "").trim(),
    );
  return resolved ? String(resolved).trim() : null;
}

function resolveAlertTargetMonth(alert: GmailMessageAlert): string | null {
  const visitAtIso = parseHistoryVisitDateIso(
    alert?.reservation?.visitDateTime,
    alert?.internalDateIso,
  );
  const match = String(visitAtIso ?? "").match(/^(\d{4}-\d{2})-\d{2}/);
  return match?.[1] ?? null;
}

async function buildReservationCalendarUrlsForAlerts(
  supabase: ReturnType<typeof createClient>,
  alerts: GmailMessageAlert[],
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  for (const alert of Array.isArray(alerts) ? alerts : []) {
    const alertId = String(alert?.id ?? "").trim();
    if (!alertId || urls.has(alertId)) continue;
    const storeKey = resolveAlertStorePartitionKey(alert);
    if (!storeKey) continue;
    const targetMonth = resolveAlertTargetMonth(alert);
    try {
      const issued = await issueAdminDashboardLoginLinkToken(supabase, {
        source: "line_gmail_reservation_alert",
        store_partition_key: storeKey,
        target_month: targetMonth,
        gmail_message_id: alertId,
      });
      urls.set(
        alertId,
        buildReservationCalendarPageUrl(storeKey, {
          loginToken: issued.token,
          targetMonth,
        }),
      );
    } catch (error) {
      console.error("buildReservationCalendarUrlsForAlerts failed:", error);
      urls.set(
        alertId,
        buildReservationCalendarPageUrl(storeKey, { targetMonth }),
      );
    }
  }
  return urls;
}

function isReservationHistoryFlexField(label: string): boolean {
  const normalized = normalizeInlineText(label);
  return normalized === "予約回数" || normalized === "履歴";
}

function parseReservationHistoryParagraphs(history: string): string[] {
  const raw = String(history ?? "").trim();
  if (!raw || raw === "不明") return [];
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (
    lines.some((line) =>
      line.startsWith("来店回数") || line.startsWith("予約回数") ||
      line.startsWith("キャンセル回数")
    )
  ) {
    return lines;
  }
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const visitCombined = line.match(
      /^(?:来店|予約)回数[　\s]*([0-9０-９]+)回$/,
    );
    if (visitCombined) {
      out.push(
        formatReservationCountLine(
          "予約回数",
          parseJapaneseCount(visitCombined[1]),
        ),
      );
      continue;
    }
    const cancelCombined = line.match(/^キャンセル回数[　\s]*([0-9０-９]+)回$/);
    if (cancelCombined) {
      out.push(
        formatReservationCountLine(
          "キャンセル回数",
          parseJapaneseCount(cancelCombined[1]),
        ),
      );
      continue;
    }
    if ((line === "来店回数" || line === "予約回数") && i + 1 < lines.length) {
      const next = lines[i + 1].match(/^([0-9０-９]+)回$/);
      if (next) {
        out.push(
          formatReservationCountLine("予約回数", parseJapaneseCount(next[1])),
        );
        i += 1;
        continue;
      }
    }
    if (line === "キャンセル回数" && i + 1 < lines.length) {
      const next = lines[i + 1].match(/^([0-9０-９]+)回$/);
      if (next) {
        out.push(
          formatReservationCountLine(
            "キャンセル回数",
            parseJapaneseCount(next[1]),
          ),
        );
        i += 1;
        continue;
      }
    }
    const visit = line.match(/^(?:来店|予約)([0-9０-９]+)回$/);
    if (visit) {
      out.push(
        formatReservationCountLine("予約回数", parseJapaneseCount(visit[1])),
      );
      continue;
    }
    const cancel = line.match(/^キャンセル([0-9０-９]+)回$/);
    if (cancel) {
      out.push(
        formatReservationCountLine(
          "キャンセル回数",
          parseJapaneseCount(cancel[1]),
        ),
      );
      continue;
    }
    if (/^過去の予約/.test(line)) {
      if (!out.includes(RESERVATION_HISTORY_HEADING)) {
        out.push(RESERVATION_HISTORY_HEADING);
      }
      continue;
    }
    if (line.startsWith("・")) {
      out.push(line.slice(1).trim());
      continue;
    }
    out.push(line);
  }
  return out;
}

function buildGmailReservationFlexParagraphRow(
  label: string,
  paragraphs: string[],
): Record<string, unknown> {
  const safeLabel = normalizeInlineText(label) || "項目";
  const lines = paragraphs
    .map((line) => String(line ?? "").trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return buildGmailReservationFlexRow(label, "不明");
  }
  return {
    type: "box",
    layout: "vertical",
    spacing: "sm",
    margin: "lg",
    contents: [
      {
        type: "text",
        text: `${safeLabel}：`,
        size: "sm",
        color: "#6b7280",
        weight: "bold",
        wrap: true,
      },
      {
        type: "box",
        layout: "vertical",
        spacing: "md",
        paddingStart: "4px",
        contents: lines.map((line) => ({
          type: "text",
          text: line,
          size: "sm",
          color: isReservationHistorySectionHeading(line)
            ? "#6b7280"
            : "#111827",
          weight: isReservationHistorySectionHeading(line) ? "bold" : "regular",
          wrap: true,
        })),
      },
    ],
  };
}

function buildGmailReservationFlexRow(
  label: string,
  value: string,
): Record<string, unknown> {
  const safeLabel = normalizeInlineText(label) || "項目";
  const safeValue = normalizeInlineText(value) || "不明";
  return {
    type: "box",
    layout: "baseline",
    spacing: "sm",
    contents: [
      {
        type: "text",
        text: safeLabel,
        size: "sm",
        color: "#6b7280",
        flex: 3,
        wrap: true,
      },
      {
        type: "text",
        text: "：",
        size: "sm",
        color: "#6b7280",
        flex: 0,
      },
      {
        type: "text",
        text: safeValue,
        size: "sm",
        color: "#111827",
        flex: 7,
        wrap: true,
      },
    ],
  };
}

function formatAlignedReservationLine(
  label: string,
  value: string,
  wrapWidth = RESERVATION_TEMPLATE_DEFAULT_VALUE_WRAP_WIDTH,
): string {
  const normalizedLabel = normalizeInlineText(label) || "項目";
  const normalizedValue = normalizeInlineText(value) || "不明";
  const paddedLabel = padTemplateLabel(
    normalizedLabel,
    RESERVATION_TEMPLATE_LABEL_WIDTH,
  );
  const head = `・${paddedLabel}：`;
  const safeWrapWidth = Math.max(
    8,
    Number.isInteger(wrapWidth)
      ? wrapWidth
      : RESERVATION_TEMPLATE_DEFAULT_VALUE_WRAP_WIDTH,
  );
  const chunks = splitByDisplayWidth(normalizedValue, safeWrapWidth);
  if (chunks.length <= 1) {
    return `${head}${chunks[0] ?? normalizedValue}`;
  }
  const continuationIndent = buildDisplayWidthIndent(
    getTemplateDisplayWidth(head),
  );
  const extraLines = chunks.slice(1).map((chunk) =>
    `${continuationIndent}${chunk}`
  );
  return [`${head}${chunks[0]}`, ...extraLines].join("\n");
}

function padTemplateLabel(label: string, targetWidth: number): string {
  let text = String(label ?? "");
  let width = getTemplateDisplayWidth(text);
  while (width + 2 <= targetWidth) {
    text += "　";
    width += 2;
  }
  if (width < targetWidth) {
    text += " ";
  }
  return text;
}

function getTemplateDisplayWidth(text: string): number {
  let width = 0;
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x007f || (code >= 0xff61 && code <= 0xff9f)) {
      width += 1;
    } else {
      width += 2;
    }
  }
  return width;
}

function buildDisplayWidthIndent(width: number): string {
  let remaining = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  let text = "";
  while (remaining >= 2) {
    text += "　";
    remaining -= 2;
  }
  if (remaining === 1) {
    text += " ";
  }
  return text;
}

function splitByDisplayWidth(text: string, maxWidth: number): string[] {
  const normalized = normalizeInlineText(text);
  if (!normalized) return [""];
  const widthLimit = Math.max(4, Math.floor(maxWidth));
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const ch of normalized) {
    const chWidth = getTemplateDisplayWidth(ch);
    if (current && currentWidth + chWidth > widthLimit) {
      lines.push(current);
      current = ch;
      currentWidth = chWidth;
      continue;
    }
    current += ch;
    currentWidth += chWidth;
  }

  if (current) lines.push(current);
  return lines;
}

function inferReservationEventLabel(params: {
  subject: string;
  snippet?: string | null;
  bodyText?: string | null;
}): ReservationEventLabel {
  const subjectText = normalizeInlineText(params.subject).toLowerCase();
  const snippetText = normalizeInlineText(String(params.snippet ?? ""))
    .toLowerCase();
  const bodyText = normalizeMultilineText(String(params.bodyText ?? ""))
    .toLowerCase();

  const shortHaystack = normalizeInlineText(`${subjectText} ${snippetText}`);
  if (!shortHaystack && !bodyText) return "新規予約";

  if (
    RESERVATION_CANCEL_SHORT_RE.test(shortHaystack) ||
    RESERVATION_CANCEL_BODY_RE.test(bodyText)
  ) {
    return "予約キャンセル";
  }
  if (
    RESERVATION_MODIFY_SHORT_RE.test(shortHaystack) ||
    RESERVATION_MODIFY_BODY_RE.test(bodyText)
  ) {
    return "予約変更";
  }
  return "新規予約";
}

function fallbackField(
  value: string | null | undefined,
  fallback: string,
): string {
  const normalized = normalizeInlineText(String(value ?? ""));
  return normalized || fallback;
}

function formatReservationRouteLabel(
  reservationSite: string | null | undefined,
  subject: string,
  from: string,
  textHint: string,
): string {
  return normalizeInlineText(String(reservationSite ?? "")) ||
    inferReservationSite(subject, from, textHint) ||
    "不明";
}

function isTabelogReservationRoute(routeLabel: string): boolean {
  const normalized = normalizeInlineText(routeLabel).toLowerCase();
  if (!normalized) return false;
  return normalized.includes("食べログ") || normalized.includes("tabelog");
}

function isIkyuReservationRoute(routeLabel: string): boolean {
  const normalized = normalizeInlineText(routeLabel).toLowerCase();
  if (!normalized) return false;
  return normalized.includes("一休") || normalized.includes("ikyu");
}

function formatVPointUsageLabel(
  rawValue: string | null | undefined,
  isTabelogRoute: boolean,
): string | null {
  const normalized = normalizeVPointUsage(rawValue);
  if (normalized) return normalized;
  if (isTabelogRoute) return "なし";
  return null;
}

function formatReservationHistoryDisplay(
  history: string,
  isTabelogRoute: boolean,
): string {
  const raw = String(history ?? "").trim();
  if (!raw || raw === "不明") {
    return isTabelogRoute ? "1回" : "不明";
  }
  if (
    raw.includes("過去の予約") ||
    raw.includes("来店回数") ||
    raw.includes("予約回数") ||
    raw.includes("キャンセル回数") ||
    raw.includes("来店") ||
    raw.includes("キャンセル")
  ) {
    return raw;
  }
  if (!isTabelogRoute) return raw;
  const normalized = normalizeInlineText(raw);
  const matched = normalized.match(/(\d+)\s*回/);
  if (!matched) return "1回";
  return `${matched[1]}回`;
}

function normalizeVPointUsage(
  rawValue: string | null | undefined,
): string | null {
  const value = normalizeInlineText(String(rawValue ?? ""));
  if (!value) return null;
  if (/^(なし|無|無し|利用なし|0(?:pt|ポイント)?|0)$/i.test(value)) {
    return "なし";
  }
  return value;
}

function formatReservationDateTimeLabel(
  raw: string | null | undefined,
  receivedIso: string | null,
): string {
  const source = normalizeInlineText(String(raw ?? ""));
  if (!source) return "不明";

  const parsed = parseReservationDateTime(source, receivedIso);
  if (!parsed) return source;

  const weekday = [
    "日",
    "月",
    "火",
    "水",
    "木",
    "金",
    "土",
  ][
    new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay()
  ];
  const hh = String(parsed.hour).padStart(2, "0");
  const mm = String(parsed.minute).padStart(2, "0");
  return `${String(parsed.year).padStart(4, "0")}/${
    String(parsed.month).padStart(2, "0")
  }/${String(parsed.day).padStart(2, "0")}(${weekday}) ${hh}:${mm}`;
}

function parseReservationDateTime(
  source: string,
  receivedIso: string | null,
):
  | { year: number; month: number; day: number; hour: number; minute: number }
  | null {
  const text = normalizeInlineText(source);
  if (!text) return null;

  const full = text.match(
    /(20\d{2})[\/\-年](\d{1,2})[\/\-月](\d{1,2})日?(?:\s*[（(][^）)]*[）)])?\s*([0-2]?\d):([0-5]\d)/,
  );
  if (full) {
    const month = Number(full[2]);
    const day = Number(full[3]);
    return {
      year: resolveReservationYear(Number(full[1]), month, day, receivedIso),
      month,
      day,
      hour: Number(full[4]),
      minute: Number(full[5]),
    };
  }

  const monthDay = text.match(
    /(\d{1,2})[\/\-月](\d{1,2})日?(?:\s*[（(][^）)]*[）)])?\s*([0-2]?\d):([0-5]\d)/,
  );
  if (monthDay) {
    const month = Number(monthDay[1]);
    const day = Number(monthDay[2]);
    return {
      year: resolveReservationYear(null, month, day, receivedIso),
      month,
      day,
      hour: Number(monthDay[3]),
      minute: Number(monthDay[4]),
    };
  }
  return null;
}

function formatReservationPartySizeLabel(
  value: string | null | undefined,
): string {
  const raw = normalizeInlineText(String(value ?? ""));
  if (!raw) return "不明";
  const withUnit = raw.match(/(\d+)\s*(?:人|名)/);
  if (withUnit) return `${withUnit[1]}名`;
  const onlyDigits = raw.match(/^\d+$/);
  if (onlyDigits) return `${onlyDigits[0]}名`;
  return raw;
}

function formatReservationPersonNameLabel(
  value: string | null | undefined,
): string {
  const raw = normalizeInlineText(String(value ?? ""));
  if (!raw) return "不明";
  const noRuby = raw.replace(/[（(][^）)]*[）)]/g, "").replace(/\s*様$/, "")
    .trim();
  return appendReservationHonorific(noRuby || "不明");
}

function appendReservationHonorific(name: string): string {
  const normalized = normalizeInlineText(String(name ?? ""));
  if (!normalized || normalized === "不明") return "不明";
  const withoutHonorific = normalized.replace(/\s*様$/, "").trim();
  if (!withoutHonorific) return "不明";
  return `${withoutHonorific} 様`;
}

function extractGmailBodyText(payload: any): string {
  const plainParts: string[] = [];
  const htmlParts: string[] = [];
  collectGmailBodyParts(payload, plainParts, htmlParts);

  const plain = normalizeMultilineText(plainParts.join("\n"));
  if (plain) return plain;

  const htmlJoined = normalizeMultilineText(htmlParts.join("\n"));
  if (!htmlJoined) return "";
  return normalizeMultilineText(stripHtmlTags(htmlJoined));
}

function collectGmailBodyParts(
  node: any,
  plainParts: string[],
  htmlParts: string[],
): void {
  if (!node || typeof node !== "object") return;

  const mimeType = String(node?.mimeType ?? "").toLowerCase();
  const bodyData = String(node?.body?.data ?? "");
  if (bodyData) {
    const decoded = decodeBase64UrlUtf8(bodyData);
    if (decoded) {
      if (mimeType.includes("text/plain")) {
        plainParts.push(decoded);
      } else if (mimeType.includes("text/html")) {
        htmlParts.push(decoded);
      } else if (!mimeType) {
        plainParts.push(decoded);
      }
    }
  }

  const parts = Array.isArray(node?.parts) ? node.parts : [];
  for (const part of parts) {
    collectGmailBodyParts(part, plainParts, htmlParts);
  }
}

function decodeBase64UrlUtf8(raw: string): string {
  const normalized = String(raw ?? "").replace(/-/g, "+").replace(/_/g, "/");
  if (!normalized) return "";
  const padding = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padding);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch (_e) {
    return "";
  }
}

function stripHtmlTags(raw: string): string {
  return String(raw ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function normalizeMultilineText(raw: string): string {
  return String(raw ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\u3000/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractReservationMailDetails(
  subject: string,
  bodyText: string,
  from: string,
  internalDateIso: string | null,
): ReservationMailDetails | null {
  const lineMap = parseColonSeparatedLines(bodyText);

  const reservationSite = inferReservationSite(subject, from, bodyText);
  const storeName = resolveStoreNameForReservationMail({
    reservationSite,
    lineMap,
    bodyText,
  });
  const reservationNo = normalizeReservationNo(
    pickLineValue(lineMap, ["予約番号"]) ??
      captureFirstMatch([subject, bodyText], [
        /予約(?:番号|NO|No)\s*[：:]\s*([A-Z0-9-]+)/i,
        /\[予約NO[：:]\s*([A-Z0-9-]+)\]/i,
        /bookingId(?:=|%3D)(?:net(?::|%3A))?([A-Z0-9-]+)/i,
      ]),
  );
  const notificationNo = captureFirstMatch([subject, bodyText], [
    /通知\s*NO\s*[：:]\s*([A-Z0-9-]+)/i,
    /通知NO[：:]\s*([A-Z0-9-]+)/i,
  ]);
  const isTabelogMail = isTabelogReservationRoute(reservationSite ?? "");
  const vPointUsage = normalizeVPointUsage(
    pickLineValue(lineMap, ["利用Vポイント", "利用ポイント", "vポイント"]) ??
      captureFirstMatch([bodyText], [
        /利用Vポイント\s*[：:]\s*([^\n]+)/i,
        /利用ポイント\s*[：:]\s*([^\n]+)/i,
      ]),
  );
  const visitDateTime = buildVisitDateTimeFromMail(
    lineMap,
    bodyText,
    subject,
    internalDateIso,
  );
  const partySize = normalizePartySizeLabel(
    pickLineValue(lineMap, ["来店人数", "人数"]) ??
      captureFirstMatch([bodyText], [
        /(?:来店人数|人数)\s*[：:]\s*([0-9０-９]+\s*(?:人|名))/i,
      ]),
  );
  const plan = pickLineValue(lineMap, ["プラン", "コース", "ご利用コース"]);
  const paymentMethod = pickLineValue(lineMap, ["決済方法"]);
  const totalAmount = normalizeAmountLabel(
    pickLineValue(lineMap, ["お支払い金額"]) ??
      pickLineValue(lineMap, ["プラン料金"]) ??
      captureFirstMatch([bodyText], [/([0-9,，]+円)/]),
  );
  const seatName = buildSeatNameFromMail(lineMap, bodyText);
  const representativeName = normalizePersonName(
    pickLineValue(lineMap, ["来店代表者氏名"]) ??
      pickLineValue(lineMap, ["予約者氏名(会員)"]) ??
      pickLineValue(lineMap, ["お名前"]),
  );
  const representativePhone = pickLineValue(lineMap, [
    "来店代表者連絡先",
    "電話番号",
  ]);
  const allergy = extractReservationAllergy(bodyText, lineMap, isTabelogMail);
  const requestNote = extractReservationRequest(bodyText, lineMap);
  const reservationHistory = extractReservationHistory(bodyText);

  const details: ReservationMailDetails = {
    reservationSite,
    storeName,
    reservationNo,
    notificationNo,
    vPointUsage,
    visitDateTime,
    partySize,
    plan,
    paymentMethod,
    totalAmount,
    seatName,
    representativeName,
    representativePhone,
    allergy,
    requestNote,
    reservationHistory,
  };

  const hasAny = Object.values(details).some((value) =>
    typeof value === "string" && value.trim().length > 0
  );
  return hasAny ? details : null;
}

function resolveStoreNameForReservationMail(params: {
  reservationSite: string | null;
  lineMap: Map<string, string>;
  bodyText: string;
}): string | null {
  const { reservationSite, lineMap, bodyText } = params;
  const labeledStore = normalizeStoreNameCandidate(
    pickLineValue(lineMap, [
      "店舗",
      "店舗名",
      "店名",
      "ご予約店舗",
      "ご予約店舗名",
    ]),
  );
  const bodyTopStore = normalizeStoreNameCandidate(
    extractStoreNameFromBody(bodyText),
  );

  // 食べログ通知は先頭の「〜様」行が店舗名として最も安定するため優先する。
  if (isTabelogReservationRoute(reservationSite ?? "")) {
    return bodyTopStore ?? labeledStore;
  }
  return labeledStore ?? bodyTopStore;
}

function normalizeStoreNameCandidate(
  raw: string | null | undefined,
): string | null {
  const candidate = normalizeInlineText(String(raw ?? ""));
  if (!candidate) return null;
  if (!isLikelyStoreName(candidate)) return null;
  return candidate;
}

function inferReservationSite(
  subject: string,
  from: string,
  bodyText: string,
): string | null {
  const explicit = normalizeInlineText(
    captureFirstMatch([bodyText], [/(?:予約サイト)\s*[：:]\s*([^\n]+)/i]) ?? "",
  );
  if (explicit) return explicit;

  const haystack = normalizeInlineText(`${subject} ${from} ${bodyText}`)
    .toLowerCase();
  if (!haystack) return null;
  if (haystack.includes("一休.comレストラン") || haystack.includes("ikyu")) {
    return "一休.comレストラン";
  }
  if (haystack.includes("食べログ") || haystack.includes("tabelog")) {
    return "食べログ";
  }
  return null;
}

function isSupportedReservationRoute(
  route: string | null | undefined,
): boolean {
  const normalized = normalizeInlineText(String(route ?? "")).toLowerCase();
  if (!normalized) return false;
  return normalized.includes("一休") ||
    normalized.includes("ikyu") ||
    normalized.includes("食べログ") ||
    normalized.includes("tabelog");
}

function normalizeReservationNo(raw: string | null): string | null {
  const normalized = normalizeInlineText(String(raw ?? ""));
  if (!normalized) return null;
  return normalized.replace(/^net/i, "");
}

function normalizePersonName(raw: string | null): string | null {
  const normalized = normalizeInlineText(String(raw ?? ""));
  if (!normalized) return null;
  const noRuby = normalized.replace(/[（(][^）)]*[）)]/g, "").replace(
    /\s*様$/,
    "",
  ).trim();
  return noRuby || null;
}

function normalizePartySizeLabel(raw: string | null): string | null {
  const normalized = normalizeInlineText(String(raw ?? ""));
  if (!normalized) return null;
  const count = normalized.match(/([0-9０-９]+)/);
  if (!count) return normalized;
  const digit = normalizeInlineText(count[1]).replace(
    /[０-９]/g,
    (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
  return `${digit}名`;
}

function normalizeAmountLabel(raw: string | null): string | null {
  const normalized = normalizeInlineText(String(raw ?? ""));
  if (!normalized) return null;
  const amount = normalized.match(/([0-9,，]+)\s*円/);
  if (!amount) return normalized;
  return `${String(amount[1]).replace(/，/g, ",")}円`;
}

function buildVisitDateTimeFromMail(
  lineMap: Map<string, string>,
  bodyText: string,
  subject: string,
  internalDateIso: string | null,
): string | null {
  const direct = pickLineValue(lineMap, ["来店日時"]);
  if (direct) return direct;

  const datePart = pickLineValue(lineMap, ["日付", "来店日"]) ??
    captureFirstMatch([subject, bodyText], [/(\d{1,2}\s*月\s*\d{1,2}\s*日)/]);
  const timePart = pickLineValue(lineMap, ["来店時刻", "来店時間", "時刻"]) ??
    captureFirstMatch([subject, bodyText], [/([0-2]?\d:[0-5]\d)/]);
  if (!datePart || !timePart) return null;

  const dateOnly = normalizeInlineText(datePart);
  const timeOnly = normalizeInlineText(timePart);
  const ymdFull = dateOnly.match(/(20\d{2})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
  if (ymdFull) {
    const month = Number(ymdFull[2]);
    const day = Number(ymdFull[3]);
    const year = resolveReservationYear(
      Number(ymdFull[1]),
      month,
      day,
      internalDateIso,
    );
    return `${year}/${String(month).padStart(2, "0")}/${
      String(Number(ymdFull[3])).padStart(2, "0")
    } ${timeOnly}`;
  }

  const md = dateOnly.match(/(\d{1,2})[\/\-月](\d{1,2})/);
  if (md) {
    const month = Number(md[1]);
    const day = Number(md[2]);
    const year = resolveReservationYear(null, month, day, internalDateIso);
    return `${String(year).padStart(4, "0")}/${
      String(month).padStart(2, "0")
    }/${String(day).padStart(2, "0")} ${timeOnly}`;
  }

  const compactDigits = dateOnly.replace(/[^\d]/g, "");
  if (compactDigits.length === 3 || compactDigits.length === 4) {
    const monthDigits = compactDigits.length === 3
      ? compactDigits.slice(0, 1)
      : compactDigits.slice(0, 2);
    const dayDigits = compactDigits.length === 3
      ? compactDigits.slice(1)
      : compactDigits.slice(2);
    const month = Number(monthDigits);
    const day = Number(dayDigits);
    if (
      Number.isInteger(month) && Number.isInteger(day) && month >= 1 &&
      month <= 12 && day >= 1 && day <= 31
    ) {
      const year = resolveReservationYear(null, month, day, internalDateIso);
      return `${String(year).padStart(4, "0")}/${
        String(month).padStart(2, "0")
      }/${String(day).padStart(2, "0")} ${timeOnly}`;
    }
  }

  return `${dateOnly} ${timeOnly}`;
}

function buildSeatNameFromMail(
  lineMap: Map<string, string>,
  bodyText: string,
): string | null {
  const seatPrimary =
    pickLineValue(lineMap, ["席", "席管理名称", "卓", "座席"]) ??
      pickLineValue(lineMap, ["席No"]);
  const seatExtra = extractLineAfterLabel(bodyText, ["席管理名称"]);
  const merged = [seatPrimary, seatExtra]
    .map((value) => normalizeInlineText(String(value ?? "")))
    .filter((value) => value.length > 0);
  if (merged.length === 0) return null;
  return Array.from(new Set(merged)).join(" / ");
}

function extractStoreNameFromBody(bodyText: string): string | null {
  const lines = String(bodyText ?? "")
    .split(/\n/)
    .map((line) => normalizeInlineText(line))
    .filter((line) => line.length > 0);

  for (const line of lines.slice(0, 20)) {
    const match = line.match(/^(.{2,70}?)\s*様$/);
    if (!match) continue;
    const candidate = normalizeInlineText(match[1]);
    if (isLikelyStoreName(candidate)) return candidate;
  }

  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith("◆")) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 7); j += 1) {
      const candidate = lines[j];
      if (isLikelyStoreName(candidate)) return candidate;
    }
  }

  return null;
}

function isLikelyStoreName(value: string): boolean {
  const text = normalizeInlineText(value);
  if (!text || text.length > 80) return false;
  if (/[:：]/.test(text)) return false;
  if (isLikelyUrlOrAddress(text)) return false;
  if (
    /^(お世話|以下の予約|ご確認|株式会社|管理画面|https?:|予約|通知|来店|プラン|席|コメント|メール|tel)/i
      .test(text)
  ) {
    return false;
  }
  if (/^[=＝\-ー_]+$/.test(text)) return false;
  return /[A-Za-zぁ-んァ-ヶ一-龠]/.test(text);
}

function isLikelyUrlOrAddress(value: string): boolean {
  const text = normalizeInlineText(value).toLowerCase();
  if (!text) return false;
  if (/^https?:\/\//.test(text) || /^www\./.test(text)) return true;
  if (/[^\s]+@[^\s]+\.[^\s]+/.test(text)) return true;
  if (
    /[a-z0-9][a-z0-9.-]*\.(?:co\.jp|com|net|org|jp|io|biz|info|app|dev)(?:[\/?#]|$)/i
      .test(text)
  ) return true;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:[\/?#].*)?$/i.test(text)) return true;
  return false;
}

function extractLineAfterLabel(
  bodyText: string,
  labels: string[],
): string | null {
  const normalizedTargets = labels.map((label) => normalizeLabelKey(label));
  const lines = String(bodyText ?? "").split(/\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const current = normalizeInlineText(lines[i]);
    const match = current.match(
      /^\s*[●◆■・]?\s*([^:：]{1,40}?)\s*[：:]\s*(.*)$/,
    );
    if (!match) continue;
    const label = normalizeLabelKey(match[1]);
    if (!normalizedTargets.includes(label)) continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = normalizeInlineText(lines[j]);
      if (!next) continue;
      if (/^\s*[●◆■・]?\s*[^:：]{1,40}\s*[：:]/.test(next)) break;
      if (/^(Q\d+\.|A\d+\.)/i.test(next)) break;
      if (/^[=＝\-ー_]{3,}$/.test(next)) continue;
      if (/^https?:/i.test(next)) break;
      return next;
    }
  }
  return null;
}

function extractQaAnswer(bodyText: string, questionNo: number): string | null {
  const lines = String(bodyText ?? "").split(/\r?\n/);
  if (lines.length === 0) return null;

  const qPattern = new RegExp(`^\\s*Q${questionNo}\\.`, "i");
  const aPattern = new RegExp(`^\\s*A${questionNo}\\.\\s*(.*)$`, "i");

  let qIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (qPattern.test(lines[i])) {
      qIndex = i;
      break;
    }
  }
  if (qIndex < 0) return null;

  for (let i = qIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const aMatch = line.match(aPattern);
    if (!aMatch) {
      if (/^\s*Q\d+\./i.test(line)) break;
      continue;
    }

    const inlineAnswer = sanitizeQaAnswerCandidate(aMatch[1] ?? "");
    if (inlineAnswer) return inlineAnswer;

    for (let j = i + 1; j < lines.length; j += 1) {
      const next = normalizeInlineText(lines[j]);
      if (!next) continue;
      if (/^\s*(Q\d+\.|A\d+\.)/i.test(next)) return null;
      if (/^\s*[●◆■・]?\s*[^:：]{1,40}\s*[：:]/.test(next)) return null;
      return sanitizeQaAnswerCandidate(next);
    }
    return null;
  }

  return null;
}

function sanitizeQaAnswerCandidate(raw: string): string | null {
  const normalized = normalizeInlineText(raw);
  if (!normalized) return null;
  if (/^(q\d+\.?|a\d+\.?)/i.test(normalized)) return null;
  if (/^(注意事項|ご?要望)\s*[：:]?/i.test(normalized)) return null;

  const markerIndex = normalized.search(
    /(?:Q\d+\.|A\d+\.|注意事項\s*[：:]|ご?要望\s*[：:])/i,
  );
  const trimmed = markerIndex >= 0
    ? normalized.slice(0, markerIndex).trim()
    : normalized;
  if (!trimmed) return null;
  if (/^(q\d+\.?|a\d+\.?)$/i.test(trimmed)) return null;
  if (/^(注意事項|ご?要望)\s*[：:]?$/i.test(trimmed)) return null;
  return trimmed;
}

function extractReservationAllergy(
  bodyText: string,
  lineMap: Map<string, string>,
  preferQaForTabelog: boolean,
): string | null {
  const allergyLabels = ["アレルギー", "食材アレルギー", "食材のアレルギー"];
  const direct = normalizeAllergyAnswer(
    pickLineValue(lineMap, allergyLabels),
  );
  if (direct) return direct;
  if (hasExplicitEmptyLabelLine(bodyText, allergyLabels)) return null;

  if (preferQaForTabelog && hasAllergyQuestionInQ1(bodyText)) {
    return normalizeAllergyAnswer(extractQaAnswer(bodyText, 1));
  }

  const qa = normalizeAllergyAnswer(extractQaAnswer(bodyText, 1));
  if (qa) return qa;

  return null;
}

function hasAllergyQuestionInQ1(bodyText: string): boolean {
  const q1Block = String(bodyText ?? "").match(/Q1\.\s*([^\n]*)/i);
  if (!q1Block || !q1Block[1]) return false;
  const q1Text = normalizeInlineText(q1Block[1]).toLowerCase();
  return q1Text.includes("アレルギー");
}

function normalizeAllergyAnswer(raw: string | null | undefined): string | null {
  const value = normalizeInlineText(String(raw ?? ""));
  if (!value) return null;
  if (/^(q\d+\.?|a\d+\.?)$/i.test(value)) return null;
  if (
    /^(なし|無|無し|ありません|特になし|該当なし|なしです|不要|記載なし)$/i
      .test(value)
  ) return null;
  if (/注意事項/.test(value)) return null;
  if (isBoilerplateReservationNoticeText(value)) return null;
  return value;
}

function extractReservationRequest(
  bodyText: string,
  lineMap: Map<string, string>,
): string | null {
  const requestLabels = ["要望", "ご要望", "コメント"];
  const direct = normalizeRequestAnswer(pickLineValue(lineMap, requestLabels));
  if (direct) return direct;
  if (hasExplicitEmptyLabelLine(bodyText, requestLabels)) return null;
  const qa2 = normalizeRequestAnswer(extractQaAnswer(bodyText, 2));
  const qa3 = normalizeRequestAnswer(extractQaAnswer(bodyText, 3));
  const mergedQa = [qa2, qa3].filter((value): value is string => !!value).join(
    " / ",
  );
  if (mergedQa) return mergedQa;
  const section = normalizeRequestAnswer(
    extractSectionValue(bodyText, ["コメント", "要望", "ご要望"]),
  );
  return section;
}

function normalizeRequestAnswer(raw: string | null | undefined): string | null {
  const value = normalizeInlineText(String(raw ?? ""));
  if (!value) return null;
  if (/^(q\d+\.?|a\d+\.?)$/i.test(value)) return null;
  if (
    /^(なし|無|無し|ありません|特になし|該当なし|なしです|不要|記載なし)$/i
      .test(value)
  ) return null;
  if (/注意事項/.test(value)) return null;
  if (isBoilerplateReservationNoticeText(value)) return null;
  return value;
}

function isBoilerplateReservationNoticeText(raw: string): boolean {
  const normalized = normalizeInlineText(raw).replace(/\s+/g, "");
  if (!normalized) return false;
  return normalized.includes("食材のアレルギー等が御座いましたら") ||
    normalized.includes("食材のアレルギーが御座いましたら") ||
    normalized.includes("ご予約時にお申し付けください") ||
    normalized.includes(
      "上記予約情報を店舗様でお使いの予約台帳に転記頂きますようお願い申し上げます",
    ) ||
    (normalized.includes("上記予約情報") &&
      normalized.includes("予約台帳に転記頂きますよう"));
}

function hasExplicitEmptyLabelLine(
  bodyText: string,
  labels: string[],
): boolean {
  const normalizedTargets = labels.map((label) => normalizeLabelKey(label));
  const lines = String(bodyText ?? "").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*[●◆■・]?\s*([^:：]{1,40}?)\s*[：:]\s*(.*)$/);
    if (!match) continue;
    const label = normalizeLabelKey(match[1]);
    if (
      !normalizedTargets.some((target) => labelKeyMatchesTarget(label, target))
    ) continue;
    const value = normalizeInlineText(match[2] ?? "");
    if (!value) return true;
    if (/^[\-ー‐―〜～/\\]+$/.test(value)) return true;
  }
  return false;
}

function extractSectionValue(
  bodyText: string,
  markers: string[],
): string | null {
  const normalizedMarkers = markers.map((marker) => normalizeLabelKey(marker));
  const lines = String(bodyText ?? "").split(/\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const current = normalizeInlineText(lines[i]).replace(/^[●◆■・]/, "");
    if (!current) continue;
    const key = normalizeLabelKey(current);
    if (
      !normalizedMarkers.some((marker) =>
        key.startsWith(marker) || key.includes(marker)
      )
    ) continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = normalizeInlineText(lines[j]);
      if (!next) continue;
      if (/^\s*[●◆■・]\s*[^\s]+/.test(next)) break;
      if (/^[=＝\-ー_]{3,}$/.test(next)) continue;
      return next;
    }
  }
  return null;
}

function extractReservationHistory(bodyText: string): string | null {
  const reservationCount = captureFirstMatch([bodyText], [
    /予約回数\s*[：:]\s*([0-9０-９]+)/i,
    /予約回数\s+([0-9０-９]+)/i,
  ]);
  const cancelCount = captureFirstMatch([bodyText], [
    /キャンセル回数\s*[：:]\s*([0-9０-９]+)/i,
    /キャンセル回数\s+([0-9０-９]+)/i,
  ]);
  const noShowCount = captureFirstMatch([bodyText], [
    /ノーショー回数\s*[：:]\s*([0-9０-９]+)/i,
    /ノーショー回数\s+([0-9０-９]+)/i,
  ]);

  if (reservationCount || cancelCount || noShowCount) {
    const reservationLabel = normalizeInlineText(
      String(reservationCount ?? "不明"),
    );
    const cancelLabel = normalizeInlineText(String(cancelCount ?? "不明"));
    const noShowLabel = normalizeInlineText(String(noShowCount ?? "不明"));
    return `予約回数${reservationLabel} / キャンセル${cancelLabel} / ノーショー${noShowLabel}`;
  }

  if (/ご予約の履歴のあるお客様です/.test(bodyText)) {
    return "履歴あり（件数不明）";
  }
  return null;
}

function hasAnyReservationMailDetails(
  details: ReservationMailDetails | null,
): boolean {
  if (!details) return false;
  for (const key of RESERVATION_DETAIL_KEYS) {
    const value = details[key];
    if (typeof value === "string" && value.trim().length > 0) return true;
  }
  return false;
}

function normalizeReservationField(
  raw: unknown,
  maxLength: number,
): string | null {
  if (raw == null) return null;
  const normalized = normalizeInlineText(String(raw));
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    return `${normalized.slice(0, maxLength)}...`;
  }
  return normalized;
}

function normalizeReservationMailDetails(
  raw: Partial<ReservationMailDetails>,
): ReservationMailDetails | null {
  const details: ReservationMailDetails = {
    reservationSite: normalizeReservationField(raw.reservationSite, 80),
    storeName: normalizeReservationField(raw.storeName, 90),
    reservationNo: normalizeReservationField(raw.reservationNo, 60),
    notificationNo: normalizeReservationField(raw.notificationNo, 60),
    vPointUsage: normalizeReservationField(raw.vPointUsage, 40),
    visitDateTime: normalizeReservationField(raw.visitDateTime, 100),
    partySize: normalizeReservationField(raw.partySize, 50),
    plan: normalizeReservationField(raw.plan, 140),
    paymentMethod: normalizeReservationField(raw.paymentMethod, 80),
    totalAmount: normalizeReservationField(raw.totalAmount, 80),
    seatName: normalizeReservationField(raw.seatName, 90),
    representativeName: normalizeReservationField(raw.representativeName, 80),
    representativePhone: normalizeReservationField(raw.representativePhone, 50),
    allergy: normalizeReservationField(raw.allergy, 80),
    requestNote: normalizeReservationField(raw.requestNote, 100),
    reservationHistory: normalizeReservationField(raw.reservationHistory, 120),
  };
  return hasAnyReservationMailDetails(details) ? details : null;
}

function countReservationCoreFields(
  details: ReservationMailDetails | null,
): number {
  if (!details) return 0;
  const coreKeys: Array<keyof ReservationMailDetails> = [
    "visitDateTime",
    "partySize",
    "plan",
    "reservationNo",
    "notificationNo",
    "totalAmount",
  ];
  return coreKeys.reduce((count, key) => count + (details[key] ? 1 : 0), 0);
}

function shouldUseAiReservationExtraction(
  details: ReservationMailDetails | null,
): boolean {
  if (!details) return true;
  return countReservationCoreFields(details) < 4;
}

function mergeReservationMailDetails(
  base: ReservationMailDetails | null,
  fallback: ReservationMailDetails | null,
): ReservationMailDetails | null {
  if (!base) return fallback;
  if (!fallback) return base;
  const merged: Partial<ReservationMailDetails> = {};
  for (const key of RESERVATION_DETAIL_KEYS) {
    merged[key] = base[key] ?? fallback[key] ?? null;
  }
  return normalizeReservationMailDetails(merged);
}

async function extractReservationMailDetailsWithGroq(params: {
  subject: string;
  bodyText: string;
  apiKey: string;
  maxBodyChars: number;
}): Promise<ReservationMailDetails | null> {
  const { subject, bodyText, apiKey, maxBodyChars } = params;
  if (!apiKey) return null;

  const normalizedSubject = normalizeInlineText(subject).slice(0, 200);
  const normalizedBody = normalizeMultilineText(bodyText || "");
  if (!normalizedSubject && !normalizedBody) return null;
  const clippedBody = normalizedBody.length > maxBodyChars
    ? `${normalizedBody.slice(0, maxBodyChars)}\n...(truncated)...`
    : normalizedBody;

  try {
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: resolveGroqTextModel(Deno.env.get("GROQ_RESERVATION_MODEL") || Deno.env.get("GROQ_CHAT_MODEL")),
          temperature: 0,
          messages: [
            {
              role: "system",
              content: [
                "あなたは予約メールの構造化抽出器です。",
                "出力はJSONのみ。説明文・コードブロックは禁止。",
                "不明な項目は null。",
                "抽出対象: reservationSite, storeName, reservationNo, notificationNo, vPointUsage, visitDateTime, partySize, plan, paymentMethod, totalAmount, seatName, representativeName, representativePhone, allergy, requestNote, reservationHistory, confidence。",
                "confidence は 0 から 1 の数値。",
              ].join("\n"),
            },
            {
              role: "user",
              content: [
                "以下のメール情報から予約情報を抽出してください。",
                "件名:",
                normalizedSubject || "(none)",
                "",
                "本文:",
                clippedBody || "(none)",
              ].join("\n"),
            },
          ],
        }),
      },
    );

    if (!response.ok) {
      const err = await response.text();
      console.error(
        "Groq reservation extraction failed:",
        response.status,
        err,
      );
      return null;
    }

    const data = await response.json();
    const content = String(data?.choices?.[0]?.message?.content ?? "").trim();
    if (!content) return null;

    const parsed = parseFirstJsonObject(content);
    if (!parsed || typeof parsed !== "object") return null;
    const raw = parsed as Record<string, unknown>;

    const confidenceRaw = Number(raw.confidence);
    if (
      Number.isFinite(confidenceRaw) &&
      confidenceRaw < GMAIL_ALERT_AI_MIN_CONFIDENCE
    ) {
      return null;
    }

    return normalizeReservationMailDetails({
      reservationSite: raw.reservationSite ?? raw.reservation_site ?? null,
      storeName: raw.storeName ?? raw.store_name ?? null,
      reservationNo: raw.reservationNo ?? raw.reservation_no ?? null,
      notificationNo: raw.notificationNo ?? raw.notification_no ?? null,
      vPointUsage: raw.vPointUsage ?? raw.v_point_usage ?? null,
      visitDateTime: raw.visitDateTime ?? raw.visit_datetime ?? null,
      partySize: raw.partySize ?? raw.party_size ?? null,
      plan: raw.plan ?? null,
      paymentMethod: raw.paymentMethod ?? raw.payment_method ?? null,
      totalAmount: raw.totalAmount ?? raw.total_amount ?? null,
      seatName: raw.seatName ?? raw.seat_name ?? null,
      representativeName: raw.representativeName ?? raw.representative_name ??
        null,
      representativePhone: raw.representativePhone ??
        raw.representative_phone ?? null,
      allergy: raw.allergy ?? null,
      requestNote: raw.requestNote ?? raw.request_note ?? null,
      reservationHistory: raw.reservationHistory ?? raw.reservation_history ??
        null,
    });
  } catch (err) {
    console.error("Failed to extract reservation details with Groq:", err);
    return null;
  }
}

function parseColonSeparatedLines(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = String(text ?? "").split(/\n/);
  for (const line of lines) {
    const match = line.match(
      /^\s*[●◆■・]?\s*([^:：]{1,40}?)\s*[：:]\s*(.+)\s*$/,
    );
    if (!match) continue;
    const label = normalizeLabelKey(match[1]);
    const value = normalizeInlineText(match[2]);
    if (!label || !value) continue;
    if (!map.has(label)) {
      map.set(label, value);
    }
  }
  return map;
}

function pickLineValue(
  map: Map<string, string>,
  labels: string[],
): string | null {
  const normalizedLabels = labels.map((label) => normalizeLabelKey(label));
  for (const key of normalizedLabels) {
    const value = map.get(key);
    if (value && value.trim()) return value.trim();
  }
  for (const [key, value] of map.entries()) {
    if (!value || !value.trim()) continue;
    if (normalizedLabels.some((target) => labelKeyMatchesTarget(key, target))) {
      return value.trim();
    }
  }
  return null;
}

function labelKeyMatchesTarget(labelKey: string, targetKey: string): boolean {
  return labelKey === targetKey ||
    labelKey.startsWith(targetKey) ||
    labelKey.endsWith(targetKey) ||
    labelKey.includes(targetKey);
}

function normalizeLabelKey(label: string): string {
  return String(label ?? "")
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function captureFirstMatch(texts: string[], patterns: RegExp[]): string | null {
  for (const text of texts) {
    const source = String(text ?? "");
    if (!source) continue;
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match && typeof match[1] === "string" && match[1].trim()) {
        return normalizeInlineText(match[1]);
      }
    }
  }
  return null;
}

function parseFirstJsonObject(raw: string): unknown | null {
  const text = String(raw ?? "");
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function truncateForLine(value: string, maxLength: number): string {
  const normalized = normalizeInlineText(value);
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function truncateForLinePreserveBreaks(
  value: string,
  maxLength: number,
): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, maxLength)}...`;
}

async function saveGmailReservationAlertLogs(
  supabase: ReturnType<typeof createClient>,
  alerts: GmailMessageAlert[],
  targetRoomId: string,
  now: Date,
): Promise<void> {
  if (alerts.length === 0) return;
  const lineSentAt = now.toISOString();
  const rows = alerts.map((alert) => ({
    gmail_message_id: alert.id,
    gmail_thread_id: alert.threadId,
    gmail_subject: alert.subject,
    gmail_from: alert.from,
    gmail_internal_date: alert.internalDateIso,
    line_target_room_id: targetRoomId,
    line_message_sent_at: lineSentAt,
  }));
  const { error } = await supabase
    .from("gmail_reservation_alert_logs")
    .upsert(rows, { onConflict: "gmail_message_id" });
  if (error) {
    throw new Error(`Failed to save Gmail alert logs: ${error.message}`);
  }
}

async function saveIgnoredGmailMessages(
  supabase: ReturnType<typeof createClient>,
  messages: IgnoredGmailMessage[],
): Promise<void> {
  if (messages.length === 0) return;
  const rows = messages.map((message) => ({
    gmail_message_id: message.id,
    gmail_thread_id: message.threadId,
    gmail_subject: message.subject,
    gmail_from: message.from,
    gmail_internal_date: message.internalDateIso,
    ignore_reason: message.reason,
    created_at: new Date().toISOString(),
  }));
  const { error } = await supabase
    .from("gmail_reservation_ignored_messages")
    .upsert(rows, { onConflict: "gmail_message_id" });
  if (error) {
    throw new Error(`Failed to save ignored Gmail messages: ${error.message}`);
  }

  const retentionCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString();
  const { error: pruneError } = await supabase
    .from("gmail_reservation_ignored_messages")
    .delete()
    .lt("created_at", retentionCutoff);
  if (pruneError) {
    console.error("Failed to prune ignored Gmail messages:", pruneError.message);
  }
}

async function writeDeliveryLog(
  supabase: ReturnType<typeof createClient>,
  payload: {
    jst_hour: number;
    status: string;
    reason?: string;
    should_send_overall: boolean;
    rooms_targeted: number;
    messages_in_queue: number;
    messages_marked_processed: number;
    line_send_attempted: boolean;
    line_send_success: boolean;
    line_http_status?: number | null;
    target_room_id: string | null;
    details?: Record<string, unknown>;
  },
) {
  try {
    const { error } = await supabase
      .from("summary_delivery_logs")
      .insert({
        ...payload,
        details: payload.details ?? {},
      });

    if (error) {
      console.error("Failed to insert summary_delivery_logs:", error.message);
      return;
    }

    await pruneDeliveryLogs(supabase, 100);
  } catch (e) {
    console.error("Unexpected error while inserting summary_delivery_logs:", e);
  }
}

async function pruneDeliveryLogs(
  supabase: ReturnType<typeof createClient>,
  keepLatest: number,
) {
  if (!Number.isInteger(keepLatest) || keepLatest <= 0) return;
  try {
    const cutoffIndex = keepLatest - 1;
    const { data: cutoff, error: cutoffError } = await supabase
      .from("summary_delivery_logs")
      .select("id")
      .order("id", { ascending: false })
      .range(cutoffIndex, cutoffIndex)
      .maybeSingle();

    if (cutoffError || !cutoff?.id) {
      return;
    }

    const { error: deleteError } = await supabase
      .from("summary_delivery_logs")
      .delete()
      .lt("id", cutoff.id);

    if (deleteError) {
      console.error(
        "Failed to prune summary_delivery_logs:",
        deleteError.message,
      );
    }
  } catch (e) {
    console.error("Unexpected error while pruning summary_delivery_logs:", e);
  }
}

async function sendLineMessage(
  to: string,
  payload: LineMessagePayload,
  token: string,
  storeKey?: string,
) {
  const fallbackText =
    truncateForLine(payload.text || "予約メール通知", 4900) || "予約メール通知";
  const richMessages = Array.isArray(payload.richMessages)
    ? payload.richMessages
    : [];

  if (richMessages.length > 0) {
    const richResult = await sendLinePush(to, richMessages, token, storeKey);
    if (richResult.ok) return richResult;

    console.warn(
      `Flex message send failed for ${to}. Falling back to plain text.`,
    );
    const fallbackResult = await sendLinePush(to, [{
      type: "text",
      text: fallbackText,
    }], token, storeKey);
    if (fallbackResult.ok) return fallbackResult;
    return fallbackResult;
  }

  return await sendLinePush(to, [{ type: "text", text: fallbackText }], token, storeKey);
}

async function sendLinePush(
  to: string,
  messages: Array<Record<string, unknown>>,
  token: string,
  storeKey?: string,
) {
  if (isBlockedByMarugosecondLockdown(storeKey, to)) {
    if (storeKey) {
      void recordLineWebhookDeliveryLog({
        storePartitionKey: storeKey,
        method: "push",
        context: "gmail_alert",
        targetRoomId: to,
        attempted: false,
        success: false,
        reason: "一時ロックダウン中のためブロック（マルゴセカンド送信元調査用）",
      });
    }
    return { ok: false as const, error: "blocked_by_marugosecond_lockdown" };
  }
  try {
    const response = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        to,
        messages,
      }),
    });

    const httpStatus = response.status;
    const ok = response.ok;
    const errText = ok ? "" : await response.text();

    if (storeKey) {
      void recordLineWebhookDeliveryLog({
        storePartitionKey: storeKey,
        method: "push",
        context: "gmail_alert",
        targetRoomId: to,
        attempted: true,
        success: ok,
        httpStatus,
        reason: ok ? "Gmail予約通知を配信しました。" : `LINEプッシュAPIエラー: ${errText.slice(0, 200)}`,
        details: { message_count: Math.min(messages.length, 5) },
      });
    }

    if (!ok) {
      console.error(
        `Failed to send LINE message to ${to}. Status: ${httpStatus} Error: ${errText}`,
      );
      return {
        ok: false as const,
        status: httpStatus,
        error: errText || `HTTP ${httpStatus}`,
      };
    }

    return { ok: true as const, status: httpStatus as number };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Network or fetch error while sending to ${to}:`, error);
    if (storeKey) {
      void recordLineWebhookDeliveryLog({
        storePartitionKey: storeKey,
        method: "push",
        context: "gmail_alert",
        targetRoomId: to,
        attempted: true,
        success: false,
        httpStatus: 0,
        reason: `LINEプッシュが例外で失敗: ${msg.slice(0, 200)}`,
        details: { message_count: Math.min(messages.length, 5) },
      });
    }
    return {
      ok: false as const,
      error: msg,
    };
  }
}

function normalizeInlineText(raw: string): string {
  return String(raw ?? "").replace(/\u3000/g, " ").replace(/\s+/g, " ").trim();
}

function parseBooleanEnv(
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (
    normalized === "1" || normalized === "true" || normalized === "yes" ||
    normalized === "on"
  ) return true;
  if (
    normalized === "0" || normalized === "false" || normalized === "no" ||
    normalized === "off"
  ) return false;
  return fallback;
}
