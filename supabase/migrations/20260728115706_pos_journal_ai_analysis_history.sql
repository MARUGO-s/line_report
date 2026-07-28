-- POS電子ジャーナルのAI月次分析履歴。
-- 分析本文・分析時点の事実スナップショットを保存し、admin-api経由で一覧/再表示/削除する。

create table if not exists public.pos_journal_ai_analyses (
  id bigint generated always as identity primary key,
  store_partition_key text not null,
  store_code text not null,
  year_month text not null,
  analysis_text text not null,
  ai_generated boolean not null default false,
  provider text,
  model text,
  warning text,
  facts_snapshot jsonb not null,
  source_file_count integer not null default 0,
  source_day_count integer not null default 0,
  gross_sales bigint not null default 0,
  guests_count integer not null default 0,
  average_spend bigint not null default 0,
  created_at timestamptz not null default now(),
  constraint pos_journal_ai_analyses_store_code_format check (store_code ~ '^[0-9]{4}$'),
  constraint pos_journal_ai_analyses_year_month_format check (year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  constraint pos_journal_ai_analyses_text_not_blank check (length(btrim(analysis_text)) > 0),
  constraint pos_journal_ai_analyses_source_counts_nonnegative check (source_file_count >= 0 and source_day_count >= 0),
  constraint pos_journal_ai_analyses_totals_nonnegative check (gross_sales >= 0 and guests_count >= 0 and average_spend >= 0)
);

create index if not exists pos_journal_ai_analyses_store_month_created_idx
  on public.pos_journal_ai_analyses (store_partition_key, year_month, created_at desc, id desc);

alter table public.pos_journal_ai_analyses enable row level security;
revoke all on table public.pos_journal_ai_analyses from anon, authenticated;
grant select, insert, delete on table public.pos_journal_ai_analyses to service_role;
grant usage, select on sequence public.pos_journal_ai_analyses_id_seq to service_role;
