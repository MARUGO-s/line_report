-- ============================================================
-- PVの「日本戦」が新たに確定したら、その予定を単独で即LINE配信する仕組み。
-- 週次ダイジェスト(tokyo-dome-weekly-cron)とは別経路。日本戦は集客大・深夜帯は深夜営業の要注意日のため、
-- 決まり次第すぐ知らせる。pg_cron(10分毎) → invoke_pv_japan_alert_cron() → Edge Function pv-japan-alert-cron。
-- 配信対象は週次ドーム配信ONのルーム(dome_weekly_enabled)。二重送信は (room_id, event_date, title) 一意で防止。
-- 送信失敗(429月間上限 等)はEdge側でログをロールバックし、次回以降に自動再試行。
-- セキュリティ: 表はRLS有効・service_roleのみ。invoke関数はSECURITY DEFINER・anon/auth から EXECUTE 剥奪。
-- ============================================================

-- 1) 二重送信防止ログ（試合×ルームで1回だけ通知）
create table if not exists public.pv_japan_alert_logs (
  room_id             text not null,
  event_date          date not null,
  title               text not null,
  store_partition_key text,
  sent_at             timestamptz not null default now(),
  primary key (room_id, event_date, title)
);
alter table public.pv_japan_alert_logs enable row level security;
grant select, insert, update, delete on public.pv_japan_alert_logs to service_role;

-- 2) 10分毎起動 cron（新規確定の日本戦PVがあれば Edge 側で単独配信）
create or replace function public.invoke_pv_japan_alert_cron()
returns void
language plpgsql
security definer
as $$
declare
  edge_function_url text;
  cron_auth_token text;
  request_id bigint;
begin
  edge_function_url := nullif(current_setting('custom.pv_japan_alert_edge_function_url', true), '');
  if edge_function_url is null then
    edge_function_url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/pv-japan-alert-cron';
  end if;

  cron_auth_token := public.resolve_edge_cron_auth_token();
  if cron_auth_token is null then
    raise warning 'invoke_pv_japan_alert_cron skipped: cron auth token is not configured';
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

  raise log 'invoke_pv_japan_alert_cron: Triggered Edge Function at %, request_id=%', edge_function_url, request_id;
end;
$$;
revoke all on function public.invoke_pv_japan_alert_cron() from public, anon, authenticated;

do $$
begin
  begin
    perform cron.unschedule('pv-japan-alert-cron-job');
  exception when others then null;
  end;
end
$$;

select cron.schedule(
  'pv-japan-alert-cron-job',
  '*/10 * * * *',
  $$ select public.invoke_pv_japan_alert_cron(); $$
);
