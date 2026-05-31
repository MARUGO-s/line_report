-- メディア閲覧を「店舗単位」で絞り込めるようにする。
--   - line_message_media に store_partition_key を追加（保存時に Webhook の店舗キーを記録）
--   - 既存の保存済みメディアは room→store（room_summary_settings.receipt_report_store_partition_key）から
--     判定できる範囲でバックフィル（不明分は NULL = 未分類）
alter table public.line_message_media
  add column if not exists store_partition_key text;

create index if not exists line_message_media_store_created_idx
  on public.line_message_media (store_partition_key, created_at desc);

update public.line_message_media m
set store_partition_key = r.receipt_report_store_partition_key
from public.room_summary_settings r
where m.room_id = r.room_id
  and r.receipt_report_store_partition_key is not null
  and (m.store_partition_key is null or m.store_partition_key = '');
