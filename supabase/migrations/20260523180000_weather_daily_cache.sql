-- 天候キャッシュは line_sales_month_budgets に store_partition_key = 'weather:{店舗キー}' で月別 JSON 保存

-- 参照用（将来 PostgREST 反映後に移行可能）
create table if not exists public.weather_daily_cache (
  cache_key text not null,
  weather_date date not null,
  temp_max_c double precision,
  precipitation_mm double precision,
  source text,
  fetched_at timestamptz not null default now(),
  primary key (cache_key, weather_date)
);

comment on table public.weather_daily_cache is
  'analytics 天候キャッシュ（参照用・未使用）。実行時は line_sales_month_budgets weather:* キー。';

create index if not exists weather_daily_cache_date_idx
  on public.weather_daily_cache (weather_date desc);

alter table public.weather_daily_cache enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'weather_daily_cache'
      and policyname = 'Service role can do everything on weather_daily_cache'
  ) then
    create policy "Service role can do everything on weather_daily_cache"
      on public.weather_daily_cache
      for all
      using (auth.jwt() ->> 'role' = 'service_role');
  end if;
end;
$$;
