-- Journal Report の店舗分離は物理テーブル分割ではなく store_partition_key で行う。
-- （saved_reports / ai_analysis_history / ai_chat_pdf_history / sales_forecasts / pos_journal_* 共通方針）
-- 公開Pagesは直接参照せず admin-api（service_role）経由。店舗スコープセッションは他店キーを拒否し、
-- フル管理者のみ横断サマリー等を許可する。
-- 本migrationは方針をスキーマコメントとして固定し、既存indexを確認する。

comment on table public.saved_reports is
  'Journal Report 保存済みレポート。店舗分離は store_partition_key。admin-api 経由のみ。';
comment on table public.ai_analysis_history is
  'Journal Report AI分析履歴。店舗分離は store_partition_key。admin-api 経由のみ。';
comment on table public.ai_chat_pdf_history is
  'Journal Report AIチャットPDF履歴。店舗分離は store_partition_key。admin-api 経由のみ。';
comment on table public.sales_forecasts is
  'Journal Report 売上予測。店舗分離は store_partition_key。admin-api 経由のみ。';

create index if not exists saved_reports_store_created_idx
  on public.saved_reports (store_partition_key, created_at desc);
create index if not exists ai_analysis_history_store_created_idx
  on public.ai_analysis_history (store_partition_key, created_at desc);
create index if not exists ai_chat_pdf_history_store_created_idx
  on public.ai_chat_pdf_history (store_partition_key, created_at desc);
create index if not exists sales_forecasts_store_created_idx
  on public.sales_forecasts (store_partition_key, created_at desc);
