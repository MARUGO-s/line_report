-- 「分析サマリー（自動）」の期間集計モード(「期間で見る」)用AIサマリーのキャッシュ。
-- 単日版(foodcourt_daily_ai_summary)はreport_id単位だが、期間集計は単一のreport_idを持たないため
-- 店舗+開始日+終了日で別キャッシュする。
create table if not exists public.foodcourt_period_ai_summary (
  id                  bigint generated always as identity primary key,
  store_partition_key text not null,
  start_date          date not null,
  end_date            date not null,
  summary_text        text not null,
  model_version       text not null,
  created_at          timestamptz not null default now(),
  constraint uq_fpas_range unique (store_partition_key, start_date, end_date)
);
create index if not exists idx_fpas_store on public.foodcourt_period_ai_summary(store_partition_key, start_date, end_date);

-- セキュリティ（恒久前提）: RLS有効・ポリシー無し（anon/authenticated不可、service_role=Edge Functions専用）。
alter table public.foodcourt_period_ai_summary enable row level security;
grant select, insert, update, delete on public.foodcourt_period_ai_summary to service_role;
