-- 小口現金: 出金額を「本体価格＋税額」に分割できるよう税額カラムを追加。
--   - amount_yen … 出金額（合計・税込）= 本体 + 税   ※従来どおり集計の主軸
--   - tax_yen    … うち消費税額（新規。既存行は 0 = 本体のみ扱い）
--   - 本体価格は amount_yen - tax_yen で表示（別カラムには持たず不整合を防ぐ）
alter table public.petty_cash_entries
  add column if not exists tax_yen integer not null default 0;
