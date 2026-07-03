-- 「分析サマリー（自動）」カードをAI生成に切り替えるためのキャッシュテーブル。
-- 従来はフロントJSの固定テンプレート(buildAnalysisText)で毎回同じ言い回しになっていたため、
-- Groq(専門AI2体→統合AI)で生成した日次サマリーを report_id 単位でキャッシュし、
-- 閲覧のたびに再生成・再課金しない運用にする（生成は初回閲覧時 or 将来のcronでの先回り生成）。
create table if not exists public.foodcourt_daily_ai_summary (
  id                  bigint generated always as identity primary key,
  report_id           bigint not null references public.foodcourt_tenant_reports(id) on delete cascade,
  store_partition_key text not null,
  business_date       date,
  summary_text        text not null,
  model_version       text not null,
  created_at          timestamptz not null default now(),
  constraint uq_fcas_report unique (report_id)
);
create index if not exists idx_fcas_store_date on public.foodcourt_daily_ai_summary(store_partition_key, business_date);

-- セキュリティ（恒久前提）: RLS有効・ポリシー無し（anon/authenticated不可、service_role=Edge Functions専用）。
alter table public.foodcourt_daily_ai_summary enable row level security;
grant select, insert, update, delete on public.foodcourt_daily_ai_summary to service_role;
