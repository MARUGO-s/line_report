-- 自己進化 Phase 2: 本番に影響しないプロンプト候補のオフライン比較準備。
-- 既存の品質合格/人承認済みrunを固定評価セットへスナップショットし、
-- 候補は明示的な手動登録だけを受け付ける。自動生成・自動昇格は行わない。

create table if not exists public.foodcourt_prompt_evaluation_sets (
  id uuid primary key default gen_random_uuid(),
  store_partition_key text not null,
  name text not null,
  status text not null default 'active' check (status in ('active', 'archived')),
  source text not null default 'accepted_rag_snapshot' check (source = 'accepted_rag_snapshot'),
  baseline_model_version text,
  case_count integer not null default 0 check (case_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_foodcourt_prompt_evaluation_sets_active_store
  on public.foodcourt_prompt_evaluation_sets (store_partition_key)
  where status = 'active';

create table if not exists public.foodcourt_prompt_evaluation_cases (
  id bigint generated always as identity primary key,
  evaluation_set_id uuid not null references public.foodcourt_prompt_evaluation_sets(id) on delete cascade,
  source_run_id uuid not null references public.foodcourt_ai_loop_runs(id) on delete restrict,
  surface text not null check (surface in ('ask', 'daily_summary', 'period_summary', 'weekly_report')),
  source_ref jsonb not null default '{}'::jsonb,
  user_input text,
  baseline_answer text not null,
  baseline_score numeric(5,2),
  baseline_model_version text,
  source_created_at timestamptz,
  created_at timestamptz not null default now(),
  unique (evaluation_set_id, source_run_id)
);

create index if not exists idx_foodcourt_prompt_evaluation_cases_set_surface
  on public.foodcourt_prompt_evaluation_cases (evaluation_set_id, surface, id);

create table if not exists public.foodcourt_prompt_candidates (
  id uuid primary key default gen_random_uuid(),
  store_partition_key text not null,
  name text not null,
  surface text not null default 'all' check (surface in ('all', 'ask', 'daily_summary', 'period_summary', 'weekly_report')),
  instructions text not null,
  status text not null default 'draft' check (status in ('draft', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_partition_key, name)
);

create index if not exists idx_foodcourt_prompt_candidates_store_status
  on public.foodcourt_prompt_candidates (store_partition_key, status, updated_at desc);

alter table public.foodcourt_prompt_evaluation_sets enable row level security;
alter table public.foodcourt_prompt_evaluation_cases enable row level security;
alter table public.foodcourt_prompt_candidates enable row level security;

revoke all on public.foodcourt_prompt_evaluation_sets from anon, authenticated;
revoke all on public.foodcourt_prompt_evaluation_cases from anon, authenticated;
revoke all on public.foodcourt_prompt_candidates from anon, authenticated;

grant select, insert, update, delete on public.foodcourt_prompt_evaluation_sets to service_role;
grant select, insert, update, delete on public.foodcourt_prompt_evaluation_cases to service_role;
grant select, insert, update, delete on public.foodcourt_prompt_candidates to service_role;
grant usage, select on sequence public.foodcourt_prompt_evaluation_cases_id_seq to service_role;

comment on table public.foodcourt_prompt_evaluation_sets is
  '自己進化Phase 2の固定評価セット。本番回答を変えず、承認済み教材を比較用に固定する。';
comment on table public.foodcourt_prompt_evaluation_cases is
  '固定評価セットのベースライン回答スナップショット。候補プロンプトの比較前提として保存する。';
comment on table public.foodcourt_prompt_candidates is
  '手動登録したプロンプト候補。候補登録だけでは本番プロンプトへ適用されない。';
