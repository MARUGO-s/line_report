-- 東京ドーム／ドームシティ各会場のイベントに「開場時間」を追加する。
-- 背景: 週次イベント配信(tokyo-dome-weekly-cron)に開場・開始時刻を載せるため。
-- 公式スケジュールに記載がある会場・日のみ埋まり、記載が無いものは null のまま（配信では行ごと省略）。

alter table public.tokyo_dome_events
  add column if not exists open_time text;

comment on column public.tokyo_dome_events.open_time is
  '開場（開門）時刻 HH:MM。公式スケジュールに記載がある場合のみ。';

-- start_time は当初「確定後の試合開始時間」専用だったが、
-- 公式スケジュール由来の予定開始（開演）時刻も入るため用途を広げる。
comment on column public.tokyo_dome_events.start_time is
  '開始（開演／試合開始）時刻 HH:MM。公式スケジュールの予定時刻、または巨人戦の実績同期値。';
