-- フードコート週次レポートのcronジョブ。
-- 毎時5分に起動し、「今がJST（UTC+9）で設定の曜日・時刻(±5分以内)」のルームだけにレポートを配信する。
-- admin-api の POST /foodcourt/weekly-report を呼び出す。

create or replace function public.invoke_foodcourt_weekly_report_cron()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  edge_function_url text;
  cron_auth_token   text;
  request_id        bigint;
  jst_now           timestamptz;
  jst_dow           int;
  jst_hour          int;
  jst_minute        int;
  r                 record;
begin
  edge_function_url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/admin-api/foodcourt/weekly-report';
  cron_auth_token   := public.resolve_edge_cron_auth_token();
  if cron_auth_token is null then
    raise warning 'invoke_foodcourt_weekly_report_cron skipped: cron auth token not configured';
    return;
  end if;

  -- 現在のJST（UTC+9）
  jst_now    := now() at time zone 'Asia/Tokyo';
  jst_dow    := extract(dow from jst_now)::int;   -- 0=日〜6=土
  jst_hour   := extract(hour from jst_now)::int;
  jst_minute := extract(minute from jst_now)::int;

  -- 週次レポートが有効なルームを巡回
  for r in
    select
      rss.room_id,
      rss.store_partition_key,
      coalesce(rss.foodcourt_weekly_dow,    1) as cfg_dow,
      coalesce(rss.foodcourt_weekly_hour,   9) as cfg_hour,
      coalesce(rss.foodcourt_weekly_minute, 0) as cfg_minute
    from public.room_summary_settings rss
    where rss.foodcourt_weekly_report_enabled = true
      and rss.store_partition_key is not null
  loop
    -- 曜日・時が一致し、分が±5分以内のとき発火
    if r.cfg_dow = jst_dow
       and r.cfg_hour = jst_hour
       and abs(r.cfg_minute - jst_minute) <= 5
    then
      select net.http_post(
        url     := edge_function_url,
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || cron_auth_token
        ),
        body := jsonb_build_object(
          'room_id',   r.room_id,
          'store_key', r.store_partition_key,
          'cron',      true
        )
      ) into request_id;

      raise log 'invoke_foodcourt_weekly_report_cron: room_id=%, store=%, request_id=%',
        r.room_id, r.store_partition_key, request_id;
    end if;
  end loop;
end;
$$;

revoke all on function public.invoke_foodcourt_weekly_report_cron() from public, anon, authenticated;

-- 既存ジョブを削除してから再登録
do $$
begin
  begin
    perform cron.unschedule('foodcourt-weekly-report-cron');
  exception when others then null;
  end;
end
$$;

-- 毎時5分に起動（UTC 毎時5分 = JST 毎時14分ずれ）
-- 実際のトリガー判定はJSTで関数内で行うため、毎時チェックでよい
select cron.schedule(
  'foodcourt-weekly-report-cron',
  '5 * * * *',
  $$ select public.invoke_foodcourt_weekly_report_cron(); $$
);
