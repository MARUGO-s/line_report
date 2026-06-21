-- 東京ドームのイベント日程を毎日取得する cron（tokyo-dome-events-cron）。
-- 仕組みは既存 cron（receipt-midreport-cron 等）と同一: invoke関数 + net.http_post + pg_cron。
-- 1日1回（JST 04:10 = UTC 19:10）に公式サイトを取得 → Groq抽出 → tokyo_dome_events へ upsert。
-- 書き込みは upsert（主キー event_date+title）で冪等のため、二重起動しても安全。

create or replace function public.invoke_tokyo_dome_events_cron()
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
  edge_function_url := nullif(current_setting('custom.tokyo_dome_events_edge_function_url', true), '');
  if edge_function_url is null then
    edge_function_url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/tokyo-dome-events-cron';
  end if;

  cron_auth_token := public.resolve_edge_cron_auth_token();
  if cron_auth_token is null then
    raise warning 'invoke_tokyo_dome_events_cron skipped: cron auth token is not configured';
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

  raise log 'invoke_tokyo_dome_events_cron: Triggered Edge Function at %, request_id=%', edge_function_url, request_id;
end;
$$;

do $$
begin
  begin
    perform cron.unschedule('tokyo-dome-events-cron-job');
  exception
    when others then
      null;
  end;
end
$$;

-- JST 04:10（= UTC 19:10）に1日1回。営業時間外で公式更新を取り込む。
select cron.schedule(
  'tokyo-dome-events-cron-job',
  '10 19 * * *',
  $$ select public.invoke_tokyo_dome_events_cron(); $$
);
