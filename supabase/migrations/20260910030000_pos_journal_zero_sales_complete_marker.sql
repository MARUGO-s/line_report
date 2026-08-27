-- 売上0円・会計0件でも、LZHの日計精算レポートを正常に解析できた日は
-- プレースホルダではない。2025-11-12のCAVACAVA原本は、保存済みSHA-256と
-- ファイル名を再照合して正常解析済みと確認したため、完了マーカーを付ける。
--
-- 他環境に対象原本が無い場合は0件更新で終了する。広い条件で別行を触らない。
update public.pos_journal_files
set
  parsed_data = jsonb_set(
    parsed_data,
    '{parsed_complete}',
    'true'::jsonb,
    true
  ),
  updated_at = now()
where store_partition_key = 'bistrocavacava'
  and store_code = '1020'
  and business_date = date '2025-11-12'
  and original_file_name = '102020251112220006060001.lzh'
  and sha256_hex = '596da7196b5b52a2ebd989e72c9b1eb2fe60c2939f6c916b55e2b4ab9d6c6386'
  and storage_deleted_at is null
  and gross_sales = 0
  and net_sales = 0
  and tax_yen = 0
  and groups_count = 0
  and guests_count = 0
  and receipts_count = 0
  and parsed_data->>'source' = '102020251112220006060001.lzh'
  and jsonb_typeof(parsed_data->'receipts') = 'array'
  and jsonb_array_length(parsed_data->'receipts') = 0
  and parsed_data->'parsed_complete' is distinct from 'true'::jsonb;
