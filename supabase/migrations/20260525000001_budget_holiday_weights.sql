-- Add optional holiday_weight and pre_holiday_weight columns to line_sales_month_budgets.
-- These override the day-of-week weight when a day is a national holiday or the eve of
-- a national holiday / Sunday.  NULL means "use the DOW weight as fallback".

ALTER TABLE public.line_sales_month_budgets
  ADD COLUMN IF NOT EXISTS holiday_weight     numeric(14,4) DEFAULT NULL
    CONSTRAINT line_sales_month_budgets_holiday_weight_chk     CHECK (holiday_weight     IS NULL OR holiday_weight     > 0),
  ADD COLUMN IF NOT EXISTS pre_holiday_weight numeric(14,4) DEFAULT NULL
    CONSTRAINT line_sales_month_budgets_pre_holiday_weight_chk CHECK (pre_holiday_weight IS NULL OR pre_holiday_weight > 0);

COMMENT ON COLUMN public.line_sales_month_budgets.holiday_weight
  IS '祭日（国民の祝日）の重み。NULL なら DOW 重みを使用。';
COMMENT ON COLUMN public.line_sales_month_budgets.pre_holiday_weight
  IS '祭日前日・日曜前日の重み。NULL なら DOW 重みを使用。';
