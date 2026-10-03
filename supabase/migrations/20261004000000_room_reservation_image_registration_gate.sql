-- 既存ルームの動作は維持し、予約スクリーンショットからの登録だけを個別に停止できる。
alter table public.room_summary_settings
  add column if not exists reservation_image_registration_enabled boolean not null default true;

comment on column public.room_summary_settings.reservation_image_registration_enabled is
  'LINE予約画像からの確認カード・新規登録・既存予約の更新を許可するか。falseなら過去のカードからも登録不可。既定true。';
