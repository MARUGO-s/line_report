#!/usr/bin/env bash
# hocbn 全店舗: ダミー売上・予算の投入 / 一括削除
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CMD="${1:-seed-all}"
SALES_TAG="${DUMMY_SALES_SEED_TAG:-line_report_dummy_sales_v1}"
BUDGET_TAG="${DUMMY_BUDGET_SEED_TAG:-line_report_dummy_budget_v1}"
YEARS="${DUMMY_SALES_YEARS:-3}"

apply_sales_functions() {
  npx supabase db query --linked -f supabase/migrations/20260523160000_dummy_sales_seed.sql
}

apply_budget_functions() {
  npx supabase db query --linked -f supabase/migrations/20260523170000_dummy_budget_seed.sql
}

apply_all_functions() {
  apply_sales_functions
  apply_budget_functions
}

seed_sales() {
  apply_sales_functions
  echo "Seeding dummy sales (tag=$SALES_TAG, years=$YEARS)..."
  npx supabase db query --linked \
    "select store_partition_key, receipt_table, inserted_count from public.seed_dummy_store_receipts('$SALES_TAG', $YEARS) order by store_partition_key"
}

seed_budgets() {
  apply_budget_functions
  echo "Seeding dummy budgets (tag=$BUDGET_TAG, years=$YEARS)..."
  npx supabase db query --linked \
    "select store_partition_key, inserted_budget_rows, inserted_closed_day_rows from public.seed_dummy_store_budgets('$BUDGET_TAG', $YEARS) order by store_partition_key"
}

delete_sales() {
  apply_sales_functions
  echo "Deleting dummy sales (tag=$SALES_TAG)..."
  npx supabase db query --linked \
    "select store_partition_key, receipt_table, deleted_count from public.delete_dummy_store_receipts('$SALES_TAG') order by store_partition_key"
}

delete_budgets() {
  apply_budget_functions
  echo "Deleting dummy budgets (tag=$BUDGET_TAG)..."
  npx supabase db query --linked \
    "select store_partition_key, deleted_budget_rows, deleted_closed_day_rows from public.delete_dummy_store_budgets('$BUDGET_TAG') order by store_partition_key"
}

case "$CMD" in
  migrate)
    apply_all_functions
    echo "Applied dummy seed SQL functions."
    ;;
  seed|seed-all)
    seed_sales
    seed_budgets
    ;;
  seed-sales)
    seed_sales
    ;;
  seed-budget|seed-budgets)
    seed_budgets
    ;;
  delete|delete-all)
    delete_budgets
    delete_sales
    ;;
  delete-sales)
    delete_sales
    ;;
  delete-budget|delete-budgets)
    delete_budgets
    ;;
  *)
    echo "Usage: $0 {migrate|seed-all|seed-sales|seed-budget|delete-all|delete-sales|delete-budget}" >&2
    exit 1
    ;;
esac
