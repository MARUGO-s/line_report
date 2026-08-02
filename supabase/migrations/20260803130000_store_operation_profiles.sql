-- Journal Report 店舗営業プロフィール（定休・ランチ有無・特別営業ルール）
-- 店舗分離は store_partition_key。admin-api（service role）経由のみ。

create table if not exists public.store_operation_profiles (
  store_partition_key text primary key,
  profile jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);

comment on table public.store_operation_profiles is
  'Journal Report 店舗営業情報（定休・ランチ等）。店舗分離は store_partition_key。admin-api 経由のみ。';

alter table public.store_operation_profiles enable row level security;

-- anon / authenticated からの直接アクセスは拒否（ポリシーなし＝deny）
