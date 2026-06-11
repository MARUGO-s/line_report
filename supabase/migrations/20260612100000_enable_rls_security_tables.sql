-- セキュリティアドバイザ ERROR 対応: RLS無効だった3テーブルを有効化。
-- いずれも Edge Functions(service-role) / SECURITY DEFINER 関数からのみ利用しており、
-- クライアント(静的ページの anon キー)からは未使用と確認済み（2026-06-12）。
-- ポリシーは作らない＝anon/authenticated からのアクセスを遮断（サービスロールはRLS非適用）。
alter table public.security_rate_limits enable row level security;
alter table public.store_webhook_tables enable row level security;
alter table public.receipt_sheets_past_sales_export_snapshot enable row level security;
