-- Journal Report AI: 過去予約を店舗別・日別に確定キャッシュする。
-- 顧客名を含むため公開フロントからは直接読ませず、admin-api(service_role)経由のみ。
-- 毎朝 JST 05:37（UTC 20:37）に昨日までを更新する。04:10/04:20/05:00 の既存日次cronと分離。

create table if not exists public.reservation_ai_store_cache (
  store_partition_key text not null,
  fact_date date not null,
  facts jsonb not null default '{}'::jsonb,
  rag_text text not null default '',
  source_row_count integer not null default 0 check (source_row_count >= 0),
  source_max_updated_at timestamptz,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (store_partition_key, fact_date)
);

create index if not exists reservation_ai_store_cache_date_idx
  on public.reservation_ai_store_cache (fact_date, store_partition_key);

comment on table public.reservation_ai_store_cache is
  'Journal Report AI向け予約確定キャッシュ。過去予約を店舗×予約日で日次集計し、未来予約はDBを直接参照する。';
comment on column public.reservation_ai_store_cache.rag_text is
  '人間/検索向けの日次予約事実テキスト。数値正本はfacts JSON。';

alter table public.reservation_ai_store_cache enable row level security;
revoke all on table public.reservation_ai_store_cache from public, anon, authenticated;
grant all on table public.reservation_ai_store_cache to service_role;

-- 過去予約が例外的に編集・削除された日を記録する。
-- 店舗名の正規化はEdge側に集約されているため、dirty日は全店舗を再計算して安全側に倒す。
create table if not exists public.reservation_ai_cache_dirty_dates (
  fact_date date primary key,
  touched_at timestamptz not null default now()
);

alter table public.reservation_ai_cache_dirty_dates enable row level security;
revoke all on table public.reservation_ai_cache_dirty_dates from public, anon, authenticated;
grant all on table public.reservation_ai_cache_dirty_dates to service_role;

create or replace function public.mark_reservation_ai_cache_dirty_date()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  old_date date;
  new_date date;
begin
  if tg_op in ('UPDATE', 'DELETE') and old.visit_at is not null then
    old_date := (old.visit_at at time zone 'Asia/Tokyo')::date;
    insert into public.reservation_ai_cache_dirty_dates (fact_date, touched_at)
    values (old_date, now())
    on conflict (fact_date) do update set touched_at = excluded.touched_at;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.visit_at is not null then
    new_date := (new.visit_at at time zone 'Asia/Tokyo')::date;
    insert into public.reservation_ai_cache_dirty_dates (fact_date, touched_at)
    values (new_date, now())
    on conflict (fact_date) do update set touched_at = excluded.touched_at;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.mark_reservation_ai_cache_dirty_date()
  from public, anon, authenticated;

drop trigger if exists tabelog_reservation_ai_cache_dirty_trg
  on public.tabelog_reservation_visit_events;
create trigger tabelog_reservation_ai_cache_dirty_trg
after insert or update or delete on public.tabelog_reservation_visit_events
for each row execute function public.mark_reservation_ai_cache_dirty_date();

drop trigger if exists ikyu_reservation_ai_cache_dirty_trg
  on public.ikyu_reservation_visit_events;
create trigger ikyu_reservation_ai_cache_dirty_trg
after insert or update or delete on public.ikyu_reservation_visit_events
for each row execute function public.mark_reservation_ai_cache_dirty_date();

drop trigger if exists manual_reservation_ai_cache_dirty_trg
  on public.manual_reservation_visit_events;
create trigger manual_reservation_ai_cache_dirty_trg
after insert or update or delete on public.manual_reservation_visit_events
for each row execute function public.mark_reservation_ai_cache_dirty_date();

create or replace function public.set_reservation_ai_store_cache_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists reservation_ai_store_cache_updated_at_trg
  on public.reservation_ai_store_cache;
create trigger reservation_ai_store_cache_updated_at_trg
before update on public.reservation_ai_store_cache
for each row execute function public.set_reservation_ai_store_cache_updated_at();

revoke all on function public.set_reservation_ai_store_cache_updated_at()
  from public, anon, authenticated;

create or replace function public.invoke_reservation_ai_cache_cron()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  edge_function_url text;
  cron_auth_token text;
  request_id bigint;
begin
  edge_function_url := nullif(
    current_setting('custom.reservation_ai_cache_edge_function_url', true),
    ''
  );
  if edge_function_url is null then
    edge_function_url :=
      'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/reservation-ai-cache-cron';
  end if;

  cron_auth_token := public.resolve_edge_cron_auth_token();
  if cron_auth_token is null then
    raise warning 'invoke_reservation_ai_cache_cron skipped: cron auth token is not configured';
    return;
  end if;

  select net.http_post(
    url := edge_function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || cron_auth_token
    ),
    body := '{}'::jsonb
  ) into request_id;

  raise log
    'invoke_reservation_ai_cache_cron: Triggered Edge Function at %, request_id=%',
    edge_function_url,
    request_id;
end;
$$;

revoke all on function public.invoke_reservation_ai_cache_cron()
  from public, anon, authenticated;

do $$
begin
  begin
    perform cron.unschedule('reservation-ai-cache-cron-job');
  exception
    when others then
      null;
  end;
end
$$;

-- JST 05:37（UTC 20:37）。既存の日次cron 04:10 / 04:20 / 05:00 と重ならない。
select cron.schedule(
  'reservation-ai-cache-cron-job',
  '37 20 * * *',
  $$ select public.invoke_reservation_ai_cache_cron(); $$
);
