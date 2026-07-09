-- フードコート現場日報（foodcourt_daily_logs）
-- 施策・動員数・担当者評価を保存し、Q&A / 日次・期間サマリー / 週次レポートの AI 分析材料にする。
-- 2026-07-08 にアプリ側で利用開始。リポジトリに migration が無かったため後追いで正式登録（idempotent）。

create table if not exists public.foodcourt_daily_logs (
  id                  bigserial primary key,
  store_partition_key text not null,
  log_date            date not null,
  handler             text,
  actions             jsonb not null default '[]'::jsonb,
  guest_impact        text,
  sales_impact        text,
  weather_note        text,
  event_note          text,
  daily_attendance    integer,
  issues              text,
  next_actions        text,
  memo                text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (store_partition_key, log_date)
);

comment on table public.foodcourt_daily_logs is
  'フードコート日報。施策(actions)・動員数(daily_attendance)・担当者評価を店舗×日付で1行保持。AI分析・予測画面の動員バッジに利用。';
comment on column public.foodcourt_daily_logs.actions is
  '施策配列 JSON: [{ "cat": "promotion|menu|service|environment|staff|other", "text": "..." }]';
comment on column public.foodcourt_daily_logs.daily_attendance is
  '当日の動員数（人）。分析画面のバッジと AI コンテキストに供給。予測モデルの expected_attendance とは別系統。';
comment on column public.foodcourt_daily_logs.guest_impact is
  '客数への影響についての担当者主観評価（AI は数値実績で裏取りする）';
comment on column public.foodcourt_daily_logs.sales_impact is
  '売上への影響についての担当者主観評価（AI は数値実績で裏取りする）';

create index if not exists foodcourt_daily_logs_store_date_idx
  on public.foodcourt_daily_logs (store_partition_key, log_date desc);

-- 既にテーブルがある環境向け: 列不足を埋める
alter table public.foodcourt_daily_logs
  add column if not exists daily_attendance integer;

alter table public.foodcourt_daily_logs
  add column if not exists memo text;

alter table public.foodcourt_daily_logs enable row level security;

-- service_role のみ（anon/authenticated は直接アクセス不可）。Edge は service_role で読み書き。
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'foodcourt_daily_logs'
      and policyname = 'service_role_all'
  ) then
    create policy "service_role_all" on public.foodcourt_daily_logs
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end
$$;

revoke all on table public.foodcourt_daily_logs from public, anon, authenticated;
grant all on table public.foodcourt_daily_logs to service_role;
grant usage, select on sequence public.foodcourt_daily_logs_id_seq to service_role;
