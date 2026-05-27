-- 管理用 LINE Bot（admin）と新規ユーザー承認フロー

select public.ensure_store_webhook_tables('admin', 'LINE管理Bot');

alter table public.line_user_permissions
  add column if not exists registration_source_store text;

comment on column public.line_user_permissions.registration_source_store is
  '友だち追加した店舗Botの store_partition_key。承認後の通知に利用。';
