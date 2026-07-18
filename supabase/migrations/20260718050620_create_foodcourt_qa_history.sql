-- フードコート分析画面で生成したQ&Aを、品質評価ループのON/OFFに関係なく保存する。
create table if not exists public.foodcourt_qa_history (
  id bigint generated always as identity primary key,
  store_partition_key text not null,
  question text not null,
  answer text not null,
  loop_score numeric(5,2),
  loop_count integer,
  source_ref jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_foodcourt_qa_history_store_created
  on public.foodcourt_qa_history (store_partition_key, created_at desc);

alter table public.foodcourt_qa_history enable row level security;
grant select, insert, delete on public.foodcourt_qa_history to service_role;

comment on table public.foodcourt_qa_history is
  'フードコート分析画面の質問と最終回答を店舗単位で保存する履歴。admin-apiからのみ操作する。';
