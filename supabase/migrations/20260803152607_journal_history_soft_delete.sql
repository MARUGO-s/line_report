-- Journal Report 履歴4種を復元可能なゴミ箱方式へ変更する。
-- DELETE API は行を物理削除せず deleted_at を設定し、通常一覧から除外する。
-- Storage上のレポートHTMLも復元に必要なため、ゴミ箱移動時には削除しない。

alter table public.saved_reports
  add column if not exists deleted_at timestamptz;

alter table public.sales_forecasts
  add column if not exists deleted_at timestamptz;

alter table public.ai_analysis_history
  add column if not exists deleted_at timestamptz;

alter table public.ai_chat_pdf_history
  add column if not exists deleted_at timestamptz;

create index if not exists saved_reports_store_deleted_created_idx
  on public.saved_reports (store_partition_key, deleted_at, created_at desc);

create index if not exists sales_forecasts_store_deleted_created_idx
  on public.sales_forecasts (store_partition_key, deleted_at, created_at desc);

create index if not exists ai_analysis_history_store_deleted_created_idx
  on public.ai_analysis_history (store_partition_key, deleted_at, created_at desc);

create index if not exists ai_chat_pdf_history_store_deleted_created_idx
  on public.ai_chat_pdf_history (store_partition_key, deleted_at, created_at desc);

comment on column public.saved_reports.deleted_at is
  'null=通常表示、非null=Journal Reportのゴミ箱。復元時はnullへ戻す。';
comment on column public.sales_forecasts.deleted_at is
  'null=通常表示、非null=Journal Reportのゴミ箱。復元時はnullへ戻す。';
comment on column public.ai_analysis_history.deleted_at is
  'null=通常表示、非null=Journal Reportのゴミ箱。復元時はnullへ戻す。';
comment on column public.ai_chat_pdf_history.deleted_at is
  'null=通常表示、非null=Journal Reportのゴミ箱。復元時はnullへ戻す。';
