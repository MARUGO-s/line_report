-- 口コミの新着通知(review_alert_enabled)は、これまで毎日08:10 JST固定でしか動かせなかった。
-- フードコート週次レポート等と同様、ルームごとに配信時刻を設定できるようにする。
-- 曜日は無し（毎日）。時・分のみ、既定は現行の固定時刻(8時10分)を維持する。
alter table public.room_summary_settings
  add column if not exists review_alert_hour   integer not null default 8,
  add column if not exists review_alert_minute  integer not null default 10;

comment on column public.room_summary_settings.review_alert_hour
  is '口コミ新着通知の配信時刻（時・JST）。既定8時。';
comment on column public.room_summary_settings.review_alert_minute
  is '口コミ新着通知の配信時刻（分・JST）。既定10分。';

-- 従来の「1日1回 08:10 固定」cronを、ルームごとの設定時刻に一致した分だけ処理する
-- 「毎分起動・関数側で時刻一致判定」方式へ変更する（reservation-today-cron等と同じパターン）。
do $$
begin
  begin
    perform cron.unschedule('review-alert-cron-job');
  exception when others then null;
  end;
end
$$;

select cron.schedule(
  'review-alert-cron-job',
  '* * * * *',
  $$ select public.invoke_review_alert_cron(); $$
);
