-- 既存予約データをすべて「ビストロ サヴァサヴァ」店舗に紐づけ直す（1回限りのバックフィル）
--
-- 背景:
--   予約メールはGmailに集約され、AIが storeName を抽出するが、カレンダー用に保存する
--   reservation_detail には storeName が含まれていなかった（buildReservationCalendarDetailPayload）。
--   そのため予約表の店舗フィルタでは全件「未分類」になる。
--   運用上、現状の予約はすべて「ビストロ サヴァサヴァ（bistrocavacava）」のものなので、
--   既存行の reservation_detail に storeName を付与して店舗別表示できるようにする。
--
-- 方針（冪等・既存キー保持）:
--   - JSON行: jsonb_set で storeName のみ付与（plan/partySize 等の既存キーは保持）。
--   - 非JSON/空行: 元テキストを plan に退避しつつ JSON 化し storeName を付与。
--   storeName の値は STORE_NAMES['bistrocavacava'] = 'ビストロ サヴァサヴァ'。
--   pages-config の resolveStoreKey が空白無視で正規化マッチするため、この表記で bistrocavacava に解決される。

DO $$
DECLARE
  store_label CONSTANT text := 'ビストロ サヴァサヴァ';
BEGIN
  IF to_regclass('public.tabelog_reservation_visit_events') IS NOT NULL THEN
    UPDATE public.tabelog_reservation_visit_events
      SET reservation_detail = jsonb_set(reservation_detail::jsonb, '{storeName}', to_jsonb(store_label), true)::text
      WHERE reservation_detail ~ '^\s*\{';
    UPDATE public.tabelog_reservation_visit_events
      SET reservation_detail = jsonb_build_object('v', 1, 'storeName', store_label,
            'plan', NULLIF(btrim(coalesce(reservation_detail, '')), ''))::text
      WHERE reservation_detail IS NULL OR reservation_detail !~ '^\s*\{';
  END IF;

  IF to_regclass('public.ikyu_reservation_visit_events') IS NOT NULL THEN
    UPDATE public.ikyu_reservation_visit_events
      SET reservation_detail = jsonb_set(reservation_detail::jsonb, '{storeName}', to_jsonb(store_label), true)::text
      WHERE reservation_detail ~ '^\s*\{';
    UPDATE public.ikyu_reservation_visit_events
      SET reservation_detail = jsonb_build_object('v', 1, 'storeName', store_label,
            'plan', NULLIF(btrim(coalesce(reservation_detail, '')), ''))::text
      WHERE reservation_detail IS NULL OR reservation_detail !~ '^\s*\{';
  END IF;
END $$;
