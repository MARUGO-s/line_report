-- 管理Bot(admin)は利用許可の承認専用（レシート・会話記録は使わない）

update public.store_webhook_tables
set display_name = 'LINE利用許可（承認専用）'
where store_partition_key = 'admin';

comment on table public.line_webhook_raw__admin is
  '管理BotのWebhook生ログ（任意・承認処理では未使用）。本番は line-admin-webhook 推奨。';
