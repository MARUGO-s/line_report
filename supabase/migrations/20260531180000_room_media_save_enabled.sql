-- ルーム単位の「メディア保存する/しない」権限。
-- false の間は当該ルームの受信メディアを「メディア閲覧」用ストレージに保存しない（既定: 保存）。
alter table public.room_summary_settings
  add column if not exists media_save_enabled boolean not null default true;

comment on column public.room_summary_settings.media_save_enabled is
  'false の間は当該ルームの受信メディア(画像/動画/音声/ファイル)をメディア閲覧用に保存しない。既定 true。';
