-- フードコート「テナント一覧」画像を受信した際、即保存ではなく「この日付でよいか」をLINEで確認してから
-- 保存する（従来は受信時刻から機械的にreport_dateを決めて即登録・ずれた場合は分析ページから手動修正のみだった）。
-- 予約スクショ取込(pending_reservation_imports)と同じ「pending → postbackで本登録/破棄」パターンを踏襲する。
create table if not exists public.pending_foodcourt_reports (
  id                  bigint generated always as identity primary key,
  store_partition_key text not null,
  room_id             text,
  line_message_id     text unique,              -- 同一画像の再送をべき等化
  base_tenant_name    text not null,
  tenants             jsonb not null,
  guessed_sales_date  date not null,            -- 受信時刻(JST)から機械推定した「売上日」（確認カードの初期表示・datetimepickerの初期値）
  status              text not null default 'pending',  -- 'pending' | 'registered' | 'dismissed'
  created_at          timestamptz not null default now()
);
create index if not exists idx_pfr_store_created on public.pending_foodcourt_reports(store_partition_key, created_at desc);

-- セキュリティ（恒久前提）: RLS有効・ポリシー無し（anon/authenticated不可、service_role=Edge Functions専用）。
alter table public.pending_foodcourt_reports enable row level security;
grant select, insert, update, delete on public.pending_foodcourt_reports to service_role;
