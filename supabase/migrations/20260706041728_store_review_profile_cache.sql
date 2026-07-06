-- 自店舗を一度詳しく精査した「店舗理解資料」を保存する。
-- 競合検索時はこの保存済み資料（RAG風コンテキスト）と競合辞典を読み込み、同系統・直接競合を優先する。

create table if not exists public.store_review_profiles (
  id bigserial primary key,
  store_review_place_id bigint not null references public.store_review_places(id) on delete cascade,
  store_partition_key text not null,
  profile_version text not null default 'store-review-profile-v1',
  model text,
  cuisine_genres text[] not null default '{}',
  service_styles text[] not null default '{}',
  price_band text,
  visit_motives text[] not null default '{}',
  customer_segments text[] not null default '{}',
  strengths text[] not null default '{}',
  weaknesses text[] not null default '{}',
  competitor_keywords text[] not null default '{}',
  adjacent_competitor_keywords text[] not null default '{}',
  excluded_keywords text[] not null default '{}',
  summary text,
  rag_document text not null default '',
  dictionary jsonb not null default '{}'::jsonb,
  source_snapshot_id bigint references public.store_review_snapshots(id) on delete set null,
  source_snapshot_date date,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint store_review_profiles_store_key_chk check (btrim(store_partition_key) <> '')
);

create unique index if not exists store_review_profiles_place_uidx
  on public.store_review_profiles (store_review_place_id);

create index if not exists store_review_profiles_store_idx
  on public.store_review_profiles (store_partition_key, updated_at desc);

alter table public.store_review_profiles enable row level security;

drop policy if exists "service_role_store_review_profiles_all" on public.store_review_profiles;
create policy "service_role_store_review_profiles_all"
  on public.store_review_profiles
  for all
  to service_role
  using (true)
  with check (true);
