-- 「置き換え」時の削除対象を「重複確認表示時点で存在していた行」に限定
-- 後から同日で新しいレシートが追加された場合、置き換えで巻き込まないようにする
alter table public.store_receipt_duplicate_pending
  add column if not exists existing_line_message_ids text;
