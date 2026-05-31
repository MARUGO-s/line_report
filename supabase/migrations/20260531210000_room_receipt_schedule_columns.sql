-- レポート（中間・月末）の送信時刻をルーム単位でDBに永続化する。
-- これまで送信時刻はブラウザの localStorage にのみ保存しており、サーバ（cron）や他端末から
-- 取り出せなかった。room_summary_settings に列を追加して、いつでもDBから取得できるようにする。
--   receipt_schedule_override: このルームで送信時刻を個別設定するか（false=一括/既定を使用）
--   receipt_midreport_*  : 中間報告の 日(1-28)/時(0-23)/分(0-59)
--   receipt_monthend_*   : 月末レポートの 日(1-28)/時(0-23)/分(0-59)
-- いずれの時刻列も NULL 可（NULL = 既定/一括設定を継承）。

alter table public.room_summary_settings
  add column if not exists receipt_schedule_override boolean not null default false,
  add column if not exists receipt_midreport_day integer,
  add column if not exists receipt_midreport_hour integer,
  add column if not exists receipt_midreport_minute integer,
  add column if not exists receipt_monthend_day integer,
  add column if not exists receipt_monthend_hour integer,
  add column if not exists receipt_monthend_minute integer;

comment on column public.room_summary_settings.receipt_schedule_override
  is 'このルームでレポート送信時刻を個別設定するか（false=既定/一括設定を使用）';
comment on column public.room_summary_settings.receipt_midreport_day
  is '中間報告の送信日(1-28)。NULL=既定継承';
comment on column public.room_summary_settings.receipt_monthend_day
  is '月末レポートの送信日(1-28)。NULL=既定継承';
