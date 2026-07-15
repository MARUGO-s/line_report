-- フードコートAIの長期学習フィードバック（本番適用version: 20260715120023）。
-- 合格回答または人が helpful と評価した回答だけを、次回生成の参考例として再利用する。

alter table public.foodcourt_ai_loop_runs
  alter column status set default 'running';

update public.foodcourt_ai_loop_runs
set status = 'failed',
    returned_reason = coalesce(returned_reason, 'interrupted'),
    updated_at = now()
where final_loop_index is null
  and final_answer is null
  and status = 'completed';

create table if not exists public.foodcourt_ai_feedback (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.foodcourt_ai_loop_runs(id) on delete cascade,
  store_partition_key text not null,
  surface text not null,
  rating text not null check (rating in ('helpful', 'not_helpful')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id)
);

create index if not exists idx_foodcourt_ai_feedback_store
  on public.foodcourt_ai_feedback (store_partition_key, surface, updated_at desc);

alter table public.foodcourt_ai_feedback enable row level security;
grant select, insert, update, delete on public.foodcourt_ai_feedback to service_role;

comment on table public.foodcourt_ai_feedback is
  '人が評価したフードコートAI回答。helpful の回答だけを次回プロンプトの参考例として再利用する。';

-- 週次レポートはキャッシュ確認後insertのため、並行実行でも同じ週が重複しないようDBでも保証する。
with ranked as (
  select id,
         row_number() over (
           partition by lower(store_partition_key), week_start
           order by created_at desc, id desc
         ) as rn
  from public.foodcourt_weekly_reports
)
delete from public.foodcourt_weekly_reports w
using ranked r
where w.id = r.id and r.rn > 1;

update public.foodcourt_weekly_reports
set store_partition_key = lower(store_partition_key)
where store_partition_key <> lower(store_partition_key);

create unique index if not exists foodcourt_weekly_reports_store_week_uniq
  on public.foodcourt_weekly_reports (store_partition_key, week_start);

-- 全期間MAPEに加え、直近14日で現在の精度とモデル選択を監視する。
alter table public.foodcourt_forecast_history
  add column if not exists rolling_mape_guests numeric,
  add column if not exists rolling_mape_sales numeric;

alter table public.foodcourt_forecast_factors
  add column if not exists rolling_mape_guests numeric,
  add column if not exists rolling_mape_sales numeric;
