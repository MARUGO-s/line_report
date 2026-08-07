#!/usr/bin/env bash
# 誤って登録された将来月の予算を調査・削除する。
# 前提: supabase link 済み（SUPABASE_ACCESS_TOKEN / DB password）
#
# Usage:
#   TARGET_MONTH=2027-08 bash scripts/delete-wrong-month-budget.sh
#   TARGET_MONTH=2027-08 DRY_RUN=1 bash scripts/delete-wrong-month-budget.sh
set -euo pipefail

MONTH="${TARGET_MONTH:-2027-08}"
DRY_RUN="${DRY_RUN:-0}"

if [[ ! "$MONTH" =~ ^[0-9]{4}-(0[1-9]|1[0-2])$ ]]; then
  echo "Invalid TARGET_MONTH: $MONTH" >&2
  exit 1
fi

YEAR="${MONTH:0:4}"
MON="${MONTH:5:2}"
DAY_FROM="${MONTH}-01"
# 月末（翌月1日の前日）を UTC で算出
DAY_TO="$(python3 - <<PY
from datetime import date, timedelta
y, m = int("${YEAR}"), int("${MON}")
nxt = date(y + (1 if m == 12 else 0), 1 if m == 12 else m + 1, 1)
print((nxt - timedelta(days=1)).isoformat())
PY
)"

echo "=== Inspect budgets for ${MONTH} ==="
supabase db query --linked --output table "
select store_partition_key, target_month, budget_yen, updated_at
from public.line_sales_month_budgets
where target_month = '${MONTH}'
order by store_partition_key;
"

echo "=== Inspect closed-days for ${MONTH} ==="
supabase db query --linked --output table "
select store_partition_key, target_month, count(*) as closed_day_count
from public.line_sales_month_store_closed_days
where target_month = '${MONTH}'
group by 1, 2
order by 1;
"

echo "=== Inspect day-budget overrides in ${MONTH} ==="
supabase db query --linked --output table "
select store_partition_key, count(*) as day_override_count, min(sales_date) as from_date, max(sales_date) as to_date
from public.line_sales_manual_day_budget
where sales_date >= '${DAY_FROM}' and sales_date <= '${DAY_TO}'
group by 1
order by 1;
"

echo "=== Inspect pending LINE budget entry for ${MONTH} ==="
supabase db query --linked --output table "
select store_partition_key, step, target_month, updated_at
from public.store_budget_entry_pending
where target_month = '${MONTH}'
order by store_partition_key;
"

echo "=== Inspect accidental manual month gross for ${MONTH} (future) ==="
supabase db query --linked --output table "
select store_partition_key, sales_month, gross_sales_yen, updated_at
from public.line_sales_manual_month_gross
where sales_month = '${MONTH}'
order by store_partition_key;
"

if [ "$DRY_RUN" = "1" ]; then
  echo "DRY_RUN=1 → delete skipped."
  exit 0
fi

echo "=== Delete ${MONTH} budget rows ==="
supabase db query --linked --output table "
with deleted as (
  delete from public.line_sales_month_budgets
  where target_month = '${MONTH}'
  returning store_partition_key, budget_yen
)
select * from deleted order by 1;
"

echo "=== Delete ${MONTH} closed-days ==="
supabase db query --linked --output table "
with deleted as (
  delete from public.line_sales_month_store_closed_days
  where target_month = '${MONTH}'
  returning store_partition_key, closed_on
)
select store_partition_key, count(*) as deleted_closed_days
from deleted
group by 1
order by 1;
"

echo "=== Delete day-budget overrides in ${MONTH} ==="
supabase db query --linked --output table "
with deleted as (
  delete from public.line_sales_manual_day_budget
  where sales_date >= '${DAY_FROM}' and sales_date <= '${DAY_TO}'
  returning store_partition_key, sales_date
)
select store_partition_key, count(*) as deleted_day_overrides
from deleted
group by 1
order by 1;
"

echo "=== Delete pending LINE budget entry for ${MONTH} ==="
supabase db query --linked --output table "
with deleted as (
  delete from public.store_budget_entry_pending
  where target_month = '${MONTH}'
  returning store_partition_key, step
)
select * from deleted order by 1;
"

echo "=== Delete accidental manual month gross for ${MONTH} ==="
supabase db query --linked --output table "
with deleted as (
  delete from public.line_sales_manual_month_gross
  where sales_month = '${MONTH}'
  returning store_partition_key, gross_sales_yen
)
select * from deleted order by 1;
"

echo "=== Verify remaining ${MONTH} budget rows (expect empty) ==="
supabase db query --linked --output table "
select store_partition_key, target_month, budget_yen
from public.line_sales_month_budgets
where target_month = '${MONTH}';
"

echo "Done."
