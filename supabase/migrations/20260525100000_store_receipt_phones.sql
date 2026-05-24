-- レシート照合用電話番号（管理画面から編集、line-webhook が参照）
alter table public.store_webhook_tables
  add column if not exists receipt_phones text[] not null default '{}';

comment on column public.store_webhook_tables.receipt_phones is
  'レシートに印字される店舗電話（数字のみ）。店名 OCR がずれても照合に使用。';

update public.store_webhook_tables
set receipt_phones = array['0353616205']::text[]
where store_partition_key = 'marugoyotsuya'
  and cardinality(coalesce(receipt_phones, '{}'::text[])) = 0;

update public.store_webhook_tables
set receipt_phones = array['0364574938']::text[]
where store_partition_key = 'bistrocavacava'
  and cardinality(coalesce(receipt_phones, '{}'::text[])) = 0;
