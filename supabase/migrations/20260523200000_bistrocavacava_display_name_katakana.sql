-- ビストロ サヴァサヴァ: 英表記表示名をカタカナに統一し、誤って作られたカタカナキー重複を除去

update public.store_webhook_tables
set display_name = 'ビストロ サヴァサヴァ'
where store_partition_key = 'bistrocavacava';

-- 旧 UI / 手動登録でできたカタカナ partition key の重複（Webhook URL としては無効）
delete from public.store_webhook_tables
where store_partition_key in ('ビストロサヴァサヴァ', 'ビストロ サヴァサヴァ');
