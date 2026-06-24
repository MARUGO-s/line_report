-- フードコート来客予測（自己再学習型）cron。毎日 JST05:00 に foodcourt-forecast-cron を起動し、
-- 蓄積実績から係数を学習し直して客数・売上を予測→forecast_predictions に upsert。冪等。
-- 仕組みは他cron（tokyo-dome-events-cron 等）と同一。

-- 予測の upsert 用一意制約（target_date×tenant×metric で1行）
create unique index if not exists forecast_predictions_uniq
  on public.forecast_predictions (target_date, tenant_name, metric);

create or replace function public.invoke_foodcourt_forecast_cron()
returns void language plpgsql security definer set search_path = public as $fn$
declare edge_function_url text; cron_auth_token text; request_id bigint;
begin
  edge_function_url := nullif(current_setting('custom.foodcourt_forecast_edge_function_url', true), '');
  if edge_function_url is null then
    edge_function_url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/foodcourt-forecast-cron';
  end if;
  cron_auth_token := public.resolve_edge_cron_auth_token();
  if cron_auth_token is null then
    raise warning 'invoke_foodcourt_forecast_cron skipped: cron auth token is not configured';
    return;
  end if;
  select net.http_post(
    url := edge_function_url,
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || cron_auth_token),
    body := '{}'::jsonb
  ) into request_id;
  raise log 'invoke_foodcourt_forecast_cron: Triggered at %, request_id=%', edge_function_url, request_id;
end; $fn$;

-- SECURITY DEFINER は anon/authenticated に EXECUTE を渡さない（RLSバイパス防止）
revoke all on function public.invoke_foodcourt_forecast_cron() from public, anon, authenticated;

do $$ begin
  begin perform cron.unschedule('foodcourt-forecast-cron-job'); exception when others then null; end;
end $$;

-- JST 05:00（= UTC 20:00）毎日。イベント取得(04:10)後、最新実績で学習し直して予測。
select cron.schedule('foodcourt-forecast-cron-job','0 20 * * *', $$ select public.invoke_foodcourt_forecast_cron(); $$);
