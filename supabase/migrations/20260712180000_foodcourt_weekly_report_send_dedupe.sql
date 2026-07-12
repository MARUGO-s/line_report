-- foodcourt-weekly-report-cron は5分おきに起動し「設定時刻との差±5分以内」で送信するため、
-- 分ぴったり設定（例: minute=0）だと :00 と :05 の2回とも条件に一致し、同じ週次レポートが
-- 同じルームへ二重送信される（2026-07-13朝、マルゴエス運営チームで発生見込みだったもの）。
-- ルーム×週で1回だけ送信できるよう、送信予約テーブルで重複を防ぐ。
create table if not exists public.foodcourt_weekly_report_sends (
  room_id    text not null,
  week_start date not null,
  sent_at    timestamptz not null default now(),
  constraint pk_foodcourt_weekly_report_sends primary key (room_id, week_start)
);

comment on table public.foodcourt_weekly_report_sends
  is 'フードコート週次レポートのLINE送信予約（ルーム×週で1回のみ）。cronの重複発火があってもLINE二重送信を防ぐ。';

alter table public.foodcourt_weekly_report_sends enable row level security;
grant select, insert, update, delete on public.foodcourt_weekly_report_sends to service_role;
