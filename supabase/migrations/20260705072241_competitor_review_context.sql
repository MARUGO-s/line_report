-- 周辺競合店の口コミ/評価を売上分析に取り込むための保存領域。
-- 外部口コミサイトをスクレイピングせず、Google Places 等の正規API結果だけを保存する。

create table if not exists public.competitor_places (
  id bigserial primary key,
  store_partition_key text not null,
  competitor_name text not null,
  source text not null default 'google_places',
  place_id text,
  address text,
  google_maps_uri text,
  lat numeric(10, 7),
  lng numeric(10, 7),
  category text,
  distance_m integer,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint competitor_places_source_chk check (source in ('google_places', 'manual')),
  constraint competitor_places_store_key_chk check (btrim(store_partition_key) <> ''),
  constraint competitor_places_name_chk check (btrim(competitor_name) <> ''),
  constraint competitor_places_distance_chk check (distance_m is null or distance_m >= 0)
);

create unique index if not exists competitor_places_google_place_uidx
  on public.competitor_places (store_partition_key, source, place_id)
  where place_id is not null and btrim(place_id) <> '';

create index if not exists competitor_places_store_active_idx
  on public.competitor_places (store_partition_key, is_active, sort_order, competitor_name);

create table if not exists public.competitor_review_snapshots (
  id bigserial primary key,
  competitor_place_id bigint not null references public.competitor_places(id) on delete cascade,
  source text not null default 'google_places',
  snapshot_date date not null default current_date,
  rating numeric(4, 2),
  user_ratings_total integer,
  review_count integer,
  review_excerpt text,
  positive_terms text[] not null default '{}',
  negative_terms text[] not null default '{}',
  ai_summary text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint competitor_review_snapshots_source_chk check (source in ('google_places', 'manual')),
  constraint competitor_review_snapshots_rating_chk check (rating is null or (rating >= 0 and rating <= 5)),
  constraint competitor_review_snapshots_user_ratings_total_chk check (user_ratings_total is null or user_ratings_total >= 0),
  constraint competitor_review_snapshots_review_count_chk check (review_count is null or review_count >= 0)
);

create unique index if not exists competitor_review_snapshots_daily_uidx
  on public.competitor_review_snapshots (competitor_place_id, snapshot_date);

create index if not exists competitor_review_snapshots_place_created_idx
  on public.competitor_review_snapshots (competitor_place_id, created_at desc);

alter table public.competitor_places enable row level security;
alter table public.competitor_review_snapshots enable row level security;

drop policy if exists "service_role_competitor_places_all" on public.competitor_places;
create policy "service_role_competitor_places_all"
  on public.competitor_places
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "service_role_competitor_review_snapshots_all" on public.competitor_review_snapshots;
create policy "service_role_competitor_review_snapshots_all"
  on public.competitor_review_snapshots
  for all
  to service_role
  using (true)
  with check (true);
