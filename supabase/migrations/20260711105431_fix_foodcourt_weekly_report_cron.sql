-- フードコート週次レポートの配信修正。
-- room_summary_settings の正本店舗キーは receipt_report_store_partition_key。
-- 5分単位の設定時刻を正確に扱うため、cron も5分ごとに実行する。

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

  jst_now    := now() at time zone 'Asia/Tokyo';
  jst_dow    := extract(dow from jst_now)::int;
  jst_hour   := extract(hour from jst_now)::int;
  jst_minute := extract(minute from jst_now)::int;

  for r in
    select
      rss.room_id,
      rss.receipt_report_store_partition_key as store_key,
      coalesce(rss.foodcourt_weekly_dow,    1) as cfg_dow,
      coalesce(rss.foodcourt_weekly_hour,   9) as cfg_hour,
      coalesce(rss.foodcourt_weekly_minute, 0) as cfg_minute
    from public.room_summary_settings rss
    where rss.foodcourt_weekly_report_enabled = true
      and rss.is_enabled = true
      and rss.bot_access_approved = true
      and nullif(trim(rss.receipt_report_store_partition_key), '') is not null
  loop
    -- 5分ごとのcronと設定時刻を完全一致させ、近接時刻の重複送信を防ぐ。
    if r.cfg_dow = jst_dow
       and r.cfg_hour = jst_hour
       and r.cfg_minute = jst_minute
    then
      select net.http_post(
        url     := edge_function_url,
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || cron_auth_token
        ),
        body := jsonb_build_object(
          'room_id',   r.room_id,
          'store_key', r.store_key,
          'cron',      true
        )
      ) into request_id;

      raise log 'invoke_foodcourt_weekly_report_cron: room_id=%, store=%, request_id=%',
        r.room_id, r.store_key, request_id;
    end if;
  end loop;
end;
$$;

revoke all on function public.invoke_foodcourt_weekly_report_cron() from public, anon, authenticated;

do $$
begin
  begin
    perform cron.unschedule('foodcourt-weekly-report-cron');
  exception when others then null;
  end;
end
$$;

select cron.schedule(
  'foodcourt-weekly-report-cron',
  '*/5 * * * *',
  $$ select public.invoke_foodcourt_weekly_report_cron(); $$
);

-- 現在フードコート分析データを持つマルゴエス運営チームを送信対象に戻す。
-- 月曜09:00（JST）に先週分を配信。以後はルーム設定画面のトグルと時刻で変更できる。
update public.room_summary_settings
set foodcourt_weekly_report_enabled = true,
    foodcourt_weekly_dow = 1,
    foodcourt_weekly_hour = 9,
    foodcourt_weekly_minute = 0,
    updated_at = now()
where room_name = 'マルゴエス運営チーム'
  and lower(receipt_report_store_partition_key) = 'marugos'
  and is_enabled = true
  and bot_access_approved = true;
