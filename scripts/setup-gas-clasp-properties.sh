#!/usr/bin/env bash
# clasp で GAS スクリプトプロパティに Secret を設定（要: clasp login + .clasp.json の scriptId）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GAS_DIR="${ROOT}/google-apps-script/receipt-sheets-pilot"
PROJECT_REF="${SUPABASE_PROJECT_REF:-hocbnifuactbvmyjraxy}"
CLASP_JSON="${GAS_DIR}/.clasp.json"

if ! command -v clasp >/dev/null 2>&1; then
  echo "clasp が見つかりません: npm install -g @google/clasp" >&2
  exit 1
fi

if ! clasp show-authorized-user >/dev/null 2>&1; then
  echo "先に clasp login を実行してください（ブラウザで Google 認証）:" >&2
  echo "  clasp login" >&2
  exit 1
fi

if [[ ! -f "${CLASP_JSON}" ]]; then
  echo "Missing ${CLASP_JSON}" >&2
  echo "" >&2
  echo "Apps Script → プロジェクトの設定 → スクリプト ID をコピーし、次を作成:" >&2
  echo '  {"scriptId":"YOUR_SCRIPT_ID","rootDir":"."}' >&2
  echo "" >&2
  echo "または: cd ${GAS_DIR} && clasp clone-script YOUR_SCRIPT_ID" >&2
  exit 1
fi

SR_KEY="$(supabase projects api-keys --project-ref "${PROJECT_REF}" -o json 2>/dev/null \
  | sed -n '/^\[/,/^\]/p' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(next(x['api_key'] for x in d if x.get('name')=='service_role'))")"

FN_URL="https://${PROJECT_REF}.supabase.co/functions/v1/receipt-sheets-sync-cron"
CFG="$(curl -sS -X POST "${FN_URL}" \
  -H "Authorization: Bearer ${SR_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"get_gas_config":true}')"

export GAS_SYNC_URL GAS_SYNC_SECRET
GAS_SYNC_URL="$(echo "${CFG}" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('ok'); print(d['supabase_receipt_sheets_sync_url'])")"
GAS_SYNC_SECRET="$(echo "${CFG}" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('ok'); print(d['receipt_sheets_sync_secret'])")"

JSON_PARAMS="$(python3 -c 'import json,os; print(json.dumps([os.environ["GAS_SYNC_URL"], os.environ["GAS_SYNC_SECRET"]]))')"

echo "Pushing Code.gs..."
(cd "${GAS_DIR}" && clasp push --force)

echo "Running cliSetSyncProperties..."
(cd "${GAS_DIR}" && clasp run cliSetSyncProperties -p "${JSON_PARAMS}")

echo ""
echo "Done. スプレッドシートを再読み込み →「接続設定を確認」"
