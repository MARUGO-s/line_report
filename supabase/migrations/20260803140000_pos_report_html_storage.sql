-- 売上レポート表示用HTML（PDF元）を JSONB から分離して保管する非公開バケット。
-- 数値の正本は saved_reports.data の KPI / sales / journalIds のまま。

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'pos-report-html',
  'pos-report-html',
  false,
  5242880,
  array[
    'text/html',
    'text/plain',
    'application/octet-stream'
  ]::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;