-- 重複確認保留中に「日付変更」を待機する状態フラグを追加
alter table public.store_receipt_duplicate_pending
  add column if not exists awaiting_date_change boolean not null default false;
