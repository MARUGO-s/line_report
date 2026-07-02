-- 2025-07 マルゴの残存データ監査（削除はしない）。
do $$
declare
  receipt_count integer := 0;
  receipt_sum bigint := 0;
  receipt_min date;
  receipt_max date;
  manual_month_count integer := 0;
  manual_month_sum bigint := 0;
  manual_day_count integer := 0;
  manual_day_sum bigint := 0;
begin
  select count(*), coalesce(sum(gross_sales_yen), 0), min(receipt_date), max(receipt_date)
    into receipt_count, receipt_sum, receipt_min, receipt_max
  from public.line_receipt__marugo
  where receipt_date >= date '2025-07-01'
    and receipt_date < date '2025-08-01';

  select count(*), coalesce(sum(gross_sales_yen), 0)
    into manual_month_count, manual_month_sum
  from public.line_sales_manual_month_gross
  where store_partition_key = 'marugo'
    and sales_month = '2025-07';

  select count(*), coalesce(sum(gross_sales_yen), 0)
    into manual_day_count, manual_day_sum
  from public.line_sales_manual_day
  where store_partition_key = 'marugo'
    and sales_date >= date '2025-07-01'
    and sales_date < date '2025-08-01';

  raise notice 'AUDIT marugo 2025-07: receipts count=%, sum=%, min=%, max=%; manual_month count=%, sum=%; manual_day count=%, sum=%',
    receipt_count, receipt_sum, receipt_min, receipt_max,
    manual_month_count, manual_month_sum,
    manual_day_count, manual_day_sum;
end;
$$;
