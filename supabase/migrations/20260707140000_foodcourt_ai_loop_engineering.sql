-- AIループエンジニアリング機能（設計: docs/AI_LOOP_ENGINEERING_DESIGN.md）。
-- フードコート売上分析AIの統合回答を品質評価AIが採点し、不合格なら改善点だけを渡して再生成、
-- 最大3ループ、不合格が続けば最高得点回答を返す仕組み。Phase 1（Q&A=/foodcourt/ask のみ）向けの土台。
--
-- 実行単位(runs)とループ単位(iterations)を分け、将来のRAG/蒸溜/回答ランキングに使えるようにする。

create table if not exists public.foodcourt_ai_loop_runs (
  id uuid primary key default gen_random_uuid(),
  store_partition_key text not null,
  surface text not null, -- 'ask' | 'daily_summary' | 'period_summary'
  source_ref jsonb not null default '{}'::jsonb,
  user_input text,
  model_version text not null,
  max_loops integer not null default 3,
  status text not null default 'completed', -- completed | failed | skipped
  final_loop_index integer,
  best_loop_index integer,
  final_score numeric(5,2),
  final_answer text,
  returned_reason text, -- passed | max_loop_best | evaluation_failed | generation_failed
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_fc_loop_runs_store_surface on public.foodcourt_ai_loop_runs (store_partition_key, surface, created_at desc);

create table if not exists public.foodcourt_ai_loop_iterations (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.foodcourt_ai_loop_runs(id) on delete cascade,
  loop_index integer not null,
  feedback_from_previous text,
  specialist_outputs jsonb not null default '{}'::jsonb,
  critic_note text,
  integrated_answer text,
  evaluation jsonb,
  total_score numeric(5,2),
  score_accuracy numeric(5,2),
  score_logic numeric(5,2),
  score_expertise numeric(5,2),
  score_practicality numeric(5,2),
  score_evidence numeric(5,2),
  passed boolean not null default false,
  usage_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(run_id, loop_index)
);

-- RLS（恒久前提）: 両テーブルとも RLS 有効・ポリシー無し（anon/authenticated 不可、service_role=Edge Functions専用）。
alter table public.foodcourt_ai_loop_runs enable row level security;
alter table public.foodcourt_ai_loop_iterations enable row level security;
grant select, insert, update, delete on public.foodcourt_ai_loop_runs to service_role;
grant select, insert, update, delete on public.foodcourt_ai_loop_iterations to service_role;

comment on table public.foodcourt_ai_loop_runs is
  'AIループエンジニアリング: 1回のユーザー質問/サマリー生成単位。品質評価→改善→再生成ループの最終結果を記録。';
comment on table public.foodcourt_ai_loop_iterations is
  'AIループエンジニアリング: 各ループの生成物・評価スコア・使用量。run_idで foodcourt_ai_loop_runs に紐づく。';
