-- ============================================================
-- 東京ドーム「週次イベント配信」機能。
-- ONのルームへ、設定した曜日・時刻に「翌週(日〜土)の東京ドームのイベント」をまとめてLINE配信する。
-- 既定の送信タイミングは 土曜 10:00（曜日・時刻はルームごとに変更可）。
-- 既定ONは MARUGO S（マルゴエス運営チーム）のみ。他ルームは設定画面のトグルで任意にON。
-- 仕組みは reservation-today-cron と同型（毎分起動→該当ルームのみ送信／ログ表で二重送信防止）。
-- ============================================================

-- 1) per-room 設定（room_summary_settings に追加）
alter table public.room_summary_settings
  add column if not exists dome_weekly_enabled boolean not null default false,
  add column if not exists dome_weekly_dow     smallint,   -- 0=日..6=土（NULL=既定6=土）
  add column if not exists dome_weekly_hour    smallint,   -- 0-23（NULL=既定10）
  add column if not exists dome_weekly_minute  smallint;   -- 0-59（NULL=既定0）

comment on column public.room_summary_settings.dome_weekly_enabled is
  'ONのルームだけ、毎週きまった曜日・時刻に翌週(日〜土)の東京ドームのイベントをまとめて配信（既定OFF）。';
comment on column public.room_summary_settings.dome_weekly_dow    is '週次ドーム配信の曜日 0=日..6=土（NULL=既定6=土）。';
comment on column public.room_summary_settings.dome_weekly_hour   is '週次ドーム配信の時(0-23・NULL=既定10)。';
comment on column public.room_summary_settings.dome_weekly_minute is '週次ドーム配信の分(0-59・NULL=既定0)。';

-- 既定ON: MARUGO S（マルゴエス運営チーム）グループのみ。土曜10:00。
update public.room_summary_settings
   set dome_weekly_enabled = true,
       dome_weekly_dow = 6, dome_weekly_hour = 10, dome_weekly_minute = 0
 where room_id = 'C51a3c2386cb1fc4247139bed89d45f52';

-- 2) 二重送信防止ログ（週の起点=日曜日 で冪等化）
create table if not exists public.tokyo_dome_weekly_logs (
  room_id             text not null,
  week_start_date     date not null,            -- 配信した週の日曜日
  store_partition_key text,
  event_count         integer,
  sent_at             timestamptz not null default now(),
  primary key (room_id, week_start_date)
);
alter table public.tokyo_dome_weekly_logs enable row level security;
grant select, insert, update, delete on public.tokyo_dome_weekly_logs to service_role;

-- 3) 毎分起動 cron（該当ルームの曜日・時刻一致時のみ関数側で送信）
create or replace function public.invoke_tokyo_dome_weekly_cron()
returns void
language plpgsql
security definer
as $$
declare
  edge_function_url text;
  cron_auth_token text;
  request_id bigint;
begin
  edge_function_url := nullif(current_setting('custom.tokyo_dome_weekly_edge_function_url', true), '');
  if edge_function_url is null then
    edge_function_url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/tokyo-dome-weekly-cron';
  end if;

  cron_auth_token := public.resolve_edge_cron_auth_token();
  if cron_auth_token is null then
    raise warning 'invoke_tokyo_dome_weekly_cron skipped: cron auth token is not configured';
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

  raise log 'invoke_tokyo_dome_weekly_cron: Triggered Edge Function at %, request_id=%', edge_function_url, request_id;
end;
$$;
revoke all on function public.invoke_tokyo_dome_weekly_cron() from public, anon, authenticated;

do $$
begin
  begin
    perform cron.unschedule('tokyo-dome-weekly-cron-job');
  exception when others then null;
  end;
end
$$;

select cron.schedule(
  'tokyo-dome-weekly-cron-job',
  '* * * * *',
  $$ select public.invoke_tokyo_dome_weekly_cron(); $$
);
