create table if not exists public.store_review_places (
  id bigserial primary key,
  store_partition_key text not null,
  store_name text,
  source text not null default 'google_places',
  place_id text,
  address text,
  google_maps_uri text,
  website_uri text,
  lat numeric(12, 8),
  lng numeric(12, 8),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint store_review_places_source_chk check (source in ('google_places', 'manual')),
  constraint store_review_places_store_key_chk check (btrim(store_partition_key) <> '')
);

create unique index if not exists store_review_places_active_uidx
  on public.store_review_places (store_partition_key)
  where is_active;

create unique index if not exists store_review_places_google_place_uidx
  on public.store_review_places (store_partition_key, source, place_id)
  where place_id is not null and btrim(place_id) <> '';

create table if not exists public.store_review_snapshots (
  id bigserial primary key,
  store_review_place_id bigint not null references public.store_review_places(id) on delete cascade,
  source text not null default 'google_places',
  snapshot_date date not null default current_date,
  rating numeric(3, 2),
  user_ratings_total integer,
  review_count integer,
  review_excerpt text,
  positive_terms text[] not null default '{}',
  negative_terms text[] not null default '{}',
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint store_review_snapshots_source_chk check (source in ('google_places', 'manual')),
  constraint store_review_snapshots_rating_chk check (rating is null or (rating >= 0 and rating <= 5)),
  constraint store_review_snapshots_user_ratings_total_chk check (user_ratings_total is null or user_ratings_total >= 0),
  constraint store_review_snapshots_review_count_chk check (review_count is null or review_count >= 0)
);

create unique index if not exists store_review_snapshots_daily_uidx
  on public.store_review_snapshots (store_review_place_id, snapshot_date);

create index if not exists store_review_snapshots_place_created_idx
  on public.store_review_snapshots (store_review_place_id, created_at desc);

alter table public.store_review_places enable row level security;
alter table public.store_review_snapshots enable row level security;

drop policy if exists "service_role_store_review_places_all" on public.store_review_places;
create policy "service_role_store_review_places_all"
  on public.store_review_places
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "service_role_store_review_snapshots_all" on public.store_review_snapshots;
create policy "service_role_store_review_snapshots_all"
  on public.store_review_snapshots
  for all
  to service_role
  using (true)
  with check (true);
