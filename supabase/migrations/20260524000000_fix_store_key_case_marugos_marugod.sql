-- Fix store_partition_key case for marugoS and marugoD that were stored lowercase
-- due to a bug in upsertManualMonthSalesEntries using .toLowerCase()

UPDATE line_sales_manual_month_gross
  SET store_partition_key = 'marugoS'
  WHERE store_partition_key = 'marugos';

UPDATE line_sales_manual_month_gross
  SET store_partition_key = 'marugoD'
  WHERE store_partition_key = 'marugod';

UPDATE line_sales_month_budgets
  SET store_partition_key = 'marugoS'
  WHERE store_partition_key = 'marugos';

UPDATE line_sales_month_budgets
  SET store_partition_key = 'marugoD'
  WHERE store_partition_key = 'marugod';

UPDATE line_sales_month_store_closed_days
  SET store_partition_key = 'marugoS'
  WHERE store_partition_key = 'marugos';

UPDATE line_sales_month_store_closed_days
  SET store_partition_key = 'marugoD'
  WHERE store_partition_key = 'marugod';
