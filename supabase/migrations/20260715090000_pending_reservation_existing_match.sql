-- 予約スクショの重複検知: 同店舗・同日・同氏名・同電話番号の予約が manual_reservation_visit_events に
-- 既に存在する場合、確認カードから「更新する（上書き）」を選べるようにする。ここに一致した既存予約の
-- id を控えておき、resv_update= postback で pending → 既存行の更新に使う。
alter table public.pending_reservation_imports
  add column if not exists existing_event_id bigint;
