-- 月間予算の重みを「平日/休日前/休日」3区分から「月火水木金土日」7曜日別に変更
-- Migrate budget weights from 3-category (weekday/pre_holiday/holiday)
-- to 7 day-of-week (mon/tue/wed/thu/fri/sat/sun)

ALTER TABLE public.line_sales_month_budgets
  ADD COLUMN mon_weight numeric(14, 4) NOT NULL DEFAULT 1
    CONSTRAINT line_sales_month_budgets_mon_weight_chk CHECK (mon_weight > 0),
  ADD COLUMN tue_weight numeric(14, 4) NOT NULL DEFAULT 1
    CONSTRAINT line_sales_month_budgets_tue_weight_chk CHECK (tue_weight > 0),
  ADD COLUMN wed_weight numeric(14, 4) NOT NULL DEFAULT 1
    CONSTRAINT line_sales_month_budgets_wed_weight_chk CHECK (wed_weight > 0),
  ADD COLUMN thu_weight numeric(14, 4) NOT NULL DEFAULT 1
    CONSTRAINT line_sales_month_budgets_thu_weight_chk CHECK (thu_weight > 0),
  ADD COLUMN fri_weight numeric(14, 4) NOT NULL DEFAULT 1
    CONSTRAINT line_sales_month_budgets_fri_weight_chk CHECK (fri_weight > 0),
  ADD COLUMN sat_weight numeric(14, 4) NOT NULL DEFAULT 1.5
    CONSTRAINT line_sales_month_budgets_sat_weight_chk CHECK (sat_weight > 0),
  ADD COLUMN sun_weight numeric(14, 4) NOT NULL DEFAULT 2
    CONSTRAINT line_sales_month_budgets_sun_weight_chk CHECK (sun_weight > 0);

-- 既存データを移行: 平日→月〜金, 休日前→土, 休日→日
UPDATE public.line_sales_month_budgets
  SET mon_weight = weekday_weight,
      tue_weight = weekday_weight,
      wed_weight = weekday_weight,
      thu_weight = weekday_weight,
      fri_weight = weekday_weight,
      sat_weight = pre_holiday_weight,
      sun_weight = holiday_weight;

-- 旧3列を削除
ALTER TABLE public.line_sales_month_budgets
  DROP COLUMN weekday_weight,
  DROP COLUMN pre_holiday_weight,
  DROP COLUMN holiday_weight;

COMMENT ON COLUMN public.line_sales_month_budgets.mon_weight IS '月曜日の予算配分重み（> 0）';
COMMENT ON COLUMN public.line_sales_month_budgets.tue_weight IS '火曜日の予算配分重み（> 0）';
COMMENT ON COLUMN public.line_sales_month_budgets.wed_weight IS '水曜日の予算配分重み（> 0）';
COMMENT ON COLUMN public.line_sales_month_budgets.thu_weight IS '木曜日の予算配分重み（> 0）';
COMMENT ON COLUMN public.line_sales_month_budgets.fri_weight IS '金曜日の予算配分重み（> 0）';
COMMENT ON COLUMN public.line_sales_month_budgets.sat_weight IS '土曜日の予算配分重み（> 0）';
COMMENT ON COLUMN public.line_sales_month_budgets.sun_weight IS '日曜日の予算配分重み（> 0）';
