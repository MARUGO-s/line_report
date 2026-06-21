-- 東京ドーム周辺の日次天気を毎日取得する cron（weather-daily-cron）。
-- 仕組みは既存 cron（tokyo-dome-events-cron 等）と同一: invoke関数 + net.http_post + pg_cron。
-- 1日1回（JST 04:20 = UTC 19:20）に Open-Meteo を取得 → weather_daily へ upsert（冪等）。

create or replace function public.invoke_weather_daily_cron()
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
  edge_function_url := nullif(current_setting('custom.weather_daily_edge_function_url', true), '');
  if edge_function_url is null then
    edge_function_url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/weather-daily-cron';
  end if;

  cron_auth_token := public.resolve_edge_cron_auth_token();
  if cron_auth_token is null then
    raise warning 'invoke_weather_daily_cron skipped: cron auth token is not configured';
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

  raise log 'invoke_weather_daily_cron: Triggered Edge Function at %, request_id=%', edge_function_url, request_id;
end;
$$;

do $$
begin
  begin
    perform cron.unschedule('weather-daily-cron-job');
  exception
    when others then
      null;
  end;
end
$$;

-- JST 04:20（= UTC 19:20）に1日1回。
select cron.schedule(
  'weather-daily-cron-job',
  '20 19 * * *',
  $$ select public.invoke_weather_daily_cron(); $$
);
