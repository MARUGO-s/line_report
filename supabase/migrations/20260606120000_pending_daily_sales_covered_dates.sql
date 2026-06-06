-- 日次売上Excel取込の「期間まるごと置換」対応。
-- ファイルに載っていた全日付（総売上0=休業の日も含む）を保持し、確認カード経由の確定時に
-- その全日付の既存レシートをクリアしてから登録できるようにする
-- （値のある日は置換、0にした日は売上なしにクリア＝古いデータが残らない）。
-- 追加のみ・非破壊。既存行はデフォルト '[]'。
alter table public.pending_daily_sales_imports
  add column if not exists covered_dates jsonb not null default '[]'::jsonb;
