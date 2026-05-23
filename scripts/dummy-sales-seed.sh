#!/usr/bin/env bash
# hocbn 全店舗 line_receipt__* へダミー売上を投入 / 一括削除
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CMD="${1:-seed}"
SEED_TAG="${DUMMY_SALES_SEED_TAG:-line_report_dummy_sales_v1}"
YEARS="${DUMMY_SALES_YEARS:-3}"

apply_functions() {
  npx supabase db query --linked -f supabase/migrations/20260523160000_dummy_sales_seed.sql
}

case "$CMD" in
  migrate)
    apply_functions
    echo "Applied dummy sales SQL functions."
    ;;
  seed)
    apply_functions
    echo "Seeding dummy sales (tag=$SEED_TAG, years=$YEARS)..."
    npx supabase db query --linked \
      "select store_partition_key, receipt_table, inserted_count from public.seed_dummy_store_receipts('$SEED_TAG', $YEARS) order by store_partition_key"
    ;;
  delete)
    apply_functions
    echo "Deleting dummy sales (tag=$SEED_TAG)..."
    npx supabase db query --linked \
      "select store_partition_key, receipt_table, deleted_count from public.delete_dummy_store_receipts('$SEED_TAG') order by store_partition_key"
    ;;
  *)
    echo "Usage: $0 {migrate|seed|delete}" >&2
    exit 1
    ;;
esac
