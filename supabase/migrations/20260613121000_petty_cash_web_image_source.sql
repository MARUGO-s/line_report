-- 小口現金: 管理画面からのレシート画像アップロード取込を LINE 画像取込と区別して保存できるようにする。
alter table public.petty_cash_entries
  drop constraint if exists petty_cash_entries_source_check;

alter table public.petty_cash_entries
  add constraint petty_cash_entries_source_check
  check (source in ('manual', 'line_image', 'web_image'));
