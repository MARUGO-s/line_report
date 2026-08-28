#!/usr/bin/env bash
# Link 済みの Supabase プロジェクトへ db push する。
# リモートにだけ残った migration 履歴（git に無い version）がある場合は
# `migration repair --status reverted` で履歴を合わせてから再 push する。
#
# 使い方（CI / 手元）:
#   supabase link --project-ref <ref> --password "$SUPABASE_DB_PASSWORD"
#   bash scripts/supabase-db-push-reconcile.sh
set -euo pipefail

extract_orphan_versions() {
  local source_log="${1:-$LOG}"
  # CLI may place multiple versions on one repair command line. Restrict the
  # first match to that hint, then emit every 14-digit version on the line.
  grep -E 'migration repair --status reverted' "$source_log" \
    | grep -Eo '[0-9]{14}' \
    | sort -u
}

# Regression-test hook: parse a captured CLI log without contacting Supabase.
if [ "${1:-}" = "--extract-orphan-versions" ]; then
  extract_orphan_versions "${2:-/dev/stdin}"
  exit 0
fi

LOG="$(mktemp)"
cleanup() { rm -f "$LOG"; }
trap cleanup EXIT

# 過去に remote だけへ残ったことが確認済みの version（git にファイルが無い）
KNOWN_ORPHANS=(20260806185129)

repair_versions() {
  local versions=("$@")
  local repaired=0
  for version in "${versions[@]}"; do
    if [[ ! "$version" =~ ^[0-9]{14}$ ]]; then
      echo "::error::不正な migration version: ${version}"
      return 1
    fi
    echo "::warning::Remote-only migration ${version} を履歴から reverted 扱いにします（スキーマは触りません）"
    if supabase migration repair --status reverted "$version"; then
      repaired=$((repaired + 1))
    else
      echo "::warning::migration repair ${version} に失敗（既に無い可能性）"
    fi
  done
  [ "$repaired" -gt 0 ]
}

echo "Running supabase db push..."
set +e
supabase db push 2>&1 | tee "$LOG"
status=${PIPESTATUS[0]}
set -e

if [ "$status" -eq 0 ]; then
  echo "db push succeeded."
  exit 0
fi

if ! grep -q 'Remote migration versions not found in local migrations directory' "$LOG"; then
  echo "::error::db push が失敗しました（orphan 履歴以外の原因）。"
  exit "$status"
fi

mapfile -t DETECTED < <(extract_orphan_versions "$LOG")
declare -A SEEN=()
ORPHANS=()
for version in "${DETECTED[@]}" "${KNOWN_ORPHANS[@]}"; do
  [ -n "$version" ] || continue
  if [ -z "${SEEN[$version]:-}" ]; then
    SEEN[$version]=1
    ORPHANS+=("$version")
  fi
done

if [ "${#ORPHANS[@]}" -eq 0 ]; then
  echo "::error::Remote-only migration を検出できませんでした。ログを確認してください。"
  exit 1
fi

echo "Detected remote-only migrations: ${ORPHANS[*]}"
if ! repair_versions "${ORPHANS[@]}"; then
  echo "::error::orphan migration の repair に失敗しました。"
  exit 1
fi

echo "Retrying supabase db push after history repair..."
supabase db push
echo "db push succeeded after history repair."
