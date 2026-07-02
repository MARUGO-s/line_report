-- 2025-07 マルゴに誤って登録されたExcel一括取込の月合計データを削除。
-- 対象は直近の誤取込に限定する:
-- - 店舗: marugo
-- - 対象月: 2025-07
-- - 金額: 30,000,000 または 300,000,000
-- - Excel一括取込由来（line_message_id / room_id / raw_payload / summary_text のいずれか）

do $$
declare
  deleted_receipts integer := 0;
  deleted_manual_month integer := 0;
  deleted_manual_day integer := 0;
begin
  delete from public.line_receipt__marugo
  where receipt_date >= date '2025-07-01'
    and receipt_date < date '2025-08-01'
    and gross_sales_yen in (30000000, 300000000)
    and (
      line_message_id = 'xlsx-import:marugo:2025-07-31'
      or room_id = 'xlsx-import'
      or raw_payload ->> 'source' = 'xlsx-import'
      or summary_text = 'Excel一括取込（総売上）'
    );
  get diagnostics deleted_receipts = row_count;

  delete from public.line_sales_manual_month_gross
  where store_partition_key = 'marugo'
    and sales_month = '2025-07'
    and gross_sales_yen in (30000000, 300000000);
  get diagnostics deleted_manual_month = row_count;

  delete from public.line_sales_manual_day
  where store_partition_key = 'marugo'
    and sales_date >= date '2025-07-01'
    and sales_date < date '2025-08-01'
    and gross_sales_yen in (30000000, 300000000);
  get diagnostics deleted_manual_day = row_count;

  raise notice 'deleted erroneous marugo 2025-07 import: receipts=%, manual_month=%, manual_day=%',
    deleted_receipts, deleted_manual_month, deleted_manual_day;
end;
$$;
