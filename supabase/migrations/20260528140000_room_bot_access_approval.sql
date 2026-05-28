-- 招待グループ／複数人トーク: ルーム単位の利用許可（承認後に Bot 機能を有効化）

alter table public.room_summary_settings
  add column if not exists bot_access_approved boolean not null default true,
  add column if not exists bot_access_notify_sent_at timestamptz;

comment on column public.room_summary_settings.bot_access_approved is
  'false の間は当該ルームでレシート・検索等の Bot 機能を停止（管理Botでルーム許可後に true）';

comment on column public.room_summary_settings.bot_access_notify_sent_at is
  'ルーム承認待ちを管理Botへ通知済みの時刻（重複通知防止）';

-- 既存ルームは従来どおり利用可
update public.room_summary_settings
set bot_access_approved = true
where bot_access_approved is distinct from true;
