-- 「明日の予約状況」配信 →「本日の予約状況」配信へ時間軸を変更（完全リネーム: tomorrow→today）。
-- 送信タイミング（ルーム個別の時・分）は不変。対象日のみ「翌日」→「当日」へ。
-- 既存マイグレーション（20260603100000 / 20260603110000）で作成済みの
--   列(tomorrow_reservation_alert_*) / ログテーブル(reservation_tomorrow_alert_logs) /
--   cronジョブ(reservation-tomorrow-cron-job) / invoke関数(invoke_reservation_tomorrow_cron)
-- を today 系へ改名する。二重送信防止は (room_id, target_date) 一意制約のまま維持。
-- ※ RENAME COLUMN は IF EXISTS 非対応のため DO ブロックで存在ガードを付ける。

-- 1) room_summary_settings の3列をリネーム
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'room_summary_settings'
               and column_name = 'tomorrow_reservation_alert_enabled') then
    alter table public.room_summary_settings
      rename column tomorrow_reservation_alert_enabled to today_reservation_alert_enabled;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'room_summary_settings'
               and column_name = 'tomorrow_reservation_alert_hour') then
    alter table public.room_summary_settings
      rename column tomorrow_reservation_alert_hour to today_reservation_alert_hour;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'room_summary_settings'
               and column_name = 'tomorrow_reservation_alert_minute') then
    alter table public.room_summary_settings
      rename column tomorrow_reservation_alert_minute to today_reservation_alert_minute;
  end if;
end
$$;

comment on column public.room_summary_settings.today_reservation_alert_enabled
  is '本日の予約状況を1日1回まとめて配信するか（Gmail予約通知とは別権限）';
comment on column public.room_summary_settings.today_reservation_alert_hour
  is '本日予約配信の送信時刻 時(0-23)。NULL=既定(18時)継承';
comment on column public.room_summary_settings.today_reservation_alert_minute
  is '本日予約配信の送信時刻 分(0-59)。NULL=既定(0分)継承';

-- 2) ログテーブルをリネーム（索引・一意制約・RLSポリシー・コメントも合わせる）
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'reservation_tomorrow_alert_logs') then
    alter table public.reservation_tomorrow_alert_logs rename to reservation_today_alert_logs;
  end if;
end
$$;

do $$
begin
  -- 一意制約（同名の裏付けインデックスも追随する）
  if exists (select 1 from pg_constraint where conname = 'reservation_tomorrow_alert_logs_room_date_uidx') then
    alter table public.reservation_today_alert_logs
      rename constraint reservation_tomorrow_alert_logs_room_date_uidx
      to reservation_today_alert_logs_room_date_uidx;
  end if;
  -- 一意制約の裏付けインデックスが旧名のままなら追随
  if exists (select 1 from pg_class where relname = 'reservation_tomorrow_alert_logs_room_date_uidx') then
    alter index public.reservation_tomorrow_alert_logs_room_date_uidx
      rename to reservation_today_alert_logs_room_date_uidx;
  end if;
  -- target_date 索引
  if exists (select 1 from pg_class where relname = 'reservation_tomorrow_alert_logs_date_idx') then
    alter index public.reservation_tomorrow_alert_logs_date_idx
      rename to reservation_today_alert_logs_date_idx;
  end if;
  -- RLSポリシー名
  if exists (select 1 from pg_policies
             where schemaname = 'public' and tablename = 'reservation_today_alert_logs'
               and policyname = 'Service role reservation_tomorrow_alert_logs') then
    alter policy "Service role reservation_tomorrow_alert_logs"
      on public.reservation_today_alert_logs
      rename to "Service role reservation_today_alert_logs";
  end if;
end
$$;

comment on table public.reservation_today_alert_logs
  is '本日予約配信の送信済み記録（room_id×target_dateで重複送信を防止）';

-- 3) cron: tomorrow ジョブ/関数を撤去し today へ作り直す（毎分起動・仕組みは不変）
create or replace function public.invoke_reservation_today_cron()
returns void
language plpgsql
security definer
as $$
declare
  edge_function_url text;
  cron_auth_token text;
  request_id bigint;
begin
  edge_function_url := nullif(current_setting('custom.reservation_today_edge_function_url', true), '');
  if edge_function_url is null then
    edge_function_url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/reservation-today-cron';
  end if;

  cron_auth_token := public.resolve_edge_cron_auth_token();
  if cron_auth_token is null then
    raise warning 'invoke_reservation_today_cron skipped: cron auth token is not configured';
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

  raise log 'invoke_reservation_today_cron: Triggered Edge Function at %, request_id=%', edge_function_url, request_id;
end;
$$;

do $$
begin
  begin
    perform cron.unschedule('reservation-tomorrow-cron-job');
  exception
    when others then
      null;
  end;
  begin
    perform cron.unschedule('reservation-today-cron-job');
  exception
    when others then
      null;
  end;
end
$$;

drop function if exists public.invoke_reservation_tomorrow_cron();

select cron.schedule(
  'reservation-today-cron-job',
  '* * * * *',
  $$ select public.invoke_reservation_today_cron(); $$
);
