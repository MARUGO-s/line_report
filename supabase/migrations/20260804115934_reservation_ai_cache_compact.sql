-- 空の日次行を保持せず、店舗ごとの生成済み期間をcoverageで管理する。

create table if not exists public.reservation_ai_cache_coverage (
  store_partition_key text primary key,
  covered_from date not null,
  covered_to date not null,
  last_success_at timestamptz not null,
  updated_at timestamptz not null default now(),
  check (covered_from <= covered_to)
);

alter table public.reservation_ai_cache_coverage enable row level security;
revoke all on table public.reservation_ai_cache_coverage from public, anon, authenticated;
grant all on table public.reservation_ai_cache_coverage to service_role;

comment on table public.reservation_ai_cache_coverage is
  '予約AIキャッシュの生成済み期間。範囲内で日次行が無ければ予約0件として扱う。';

insert into public.reservation_ai_cache_coverage (
  store_partition_key, covered_from, covered_to, last_success_at, updated_at
)
select
  store_partition_key,
  min(fact_date),
  max(fact_date),
  max(generated_at),
  now()
from public.reservation_ai_store_cache
group by store_partition_key
on conflict (store_partition_key) do update
set covered_from = least(reservation_ai_cache_coverage.covered_from, excluded.covered_from),
    covered_to = greatest(reservation_ai_cache_coverage.covered_to, excluded.covered_to),
    last_success_at = greatest(reservation_ai_cache_coverage.last_success_at, excluded.last_success_at),
    updated_at = now();

delete from public.reservation_ai_store_cache
where source_row_count = 0;

-- 初回再構築やdirty日再計算は長くなるため、pg_netの待機を5秒から5分へ延長する。
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
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  ) into request_id;
  raise log
    'invoke_reservation_ai_cache_cron: Triggered Edge Function at %, request_id=%',
    edge_function_url,
    request_id;
end;
$$;

revoke all on function public.invoke_reservation_ai_cache_cron()
  from public, anon, authenticated;
