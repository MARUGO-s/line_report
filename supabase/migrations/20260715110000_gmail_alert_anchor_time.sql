-- Gmail予約通知のまとめ配信を「最後に送った時刻」ではなく、ルームごとの固定基準時刻で判定する。
-- 例: 基準10:00・12時間ごとなら10:00/22:00、1日1回なら毎日10:00に配信する。
alter table public.room_summary_settings
  add column if not exists gmail_alert_anchor_hour integer,
  add column if not exists gmail_alert_anchor_minute integer;

comment on column public.room_summary_settings.gmail_alert_anchor_hour
  is 'Gmail予約通知まとめ配信の基準時刻（時、NULLは既定10時）';
comment on column public.room_summary_settings.gmail_alert_anchor_minute
  is 'Gmail予約通知まとめ配信の基準時刻（分、NULLは既定0分）';
