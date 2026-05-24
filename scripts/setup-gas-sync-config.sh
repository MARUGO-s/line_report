#!/usr/bin/env bash
# hocbn の RECEIPT_SHEETS_* をスプレッドシート「設定」タブへ書き込む（GAS が参照）
# 404 のときはサービスアカウントをシートに「編集者」共有してから再実行
set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-hocbnifuactbvmyjraxy}"
SPREADSHEET_ID="${RECEIPT_SHEETS_PILOT_SPREADSHEET_ID:-1ykltznAplFvOsj_DCXPXla_6z_PrCxTthROlsUrr7Rs}"

SR_KEY="$(supabase projects api-keys --project-ref "${PROJECT_REF}" -o json 2>/dev/null \
  | sed -n '/^\[/,/^\]/p' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(next(x['api_key'] for x in d if x.get('name')=='service_role'))")"

FN_URL="https://${PROJECT_REF}.supabase.co/functions/v1/receipt-sheets-sync-cron"

fetch_config() {
  curl -sS -X POST "${FN_URL}" \
    -H "Authorization: Bearer ${SR_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"get_gas_config":true}'
}

print_share_instructions() {
  local cfg="$1"
  echo "${cfg}" | python3 -c "
import json, sys
d = json.load(sys.stdin)
if not d.get('ok'):
    sys.exit(1)
email = d.get('google_service_account_email') or '(GOOGLE_SERVICE_ACCOUNT_EMAIL が hocbn に未設定)'
sid = d.get('spreadsheet_id') or '${SPREADSHEET_ID}'
print()
print('=== CLI 自動書き込みの前に 1 回だけ（Google スプレッドシート）===')
print('1. スプレッドシートを開く:')
print('   https://docs.google.com/spreadsheets/d/' + sid + '/edit')
print('2. 共有 → 次のメールを「編集者」で追加:')
print('   ' + email)
proj = d.get('google_cloud_project_for_sa') or ''
print('3. （初回のみ）サービスアカウントの GCP プロジェクトで Sheets API を有効化:')
if proj:
    print('   プロジェクト: ' + proj)
print('   ' + (d.get('sheets_api_enable_url') or ''))
print('4. このスクリプトを再実行: ./scripts/setup-gas-sync-config.sh')
print()
print('Script Properties へ直接入れる場合: ./scripts/setup-gas-clasp-properties.sh')
"
}

echo "Writing GAS sync config to spreadsheet ${SPREADSHEET_ID} on ${PROJECT_REF}..."

RESP="$(curl -sS -X POST "${FN_URL}" \
  -H "Authorization: Bearer ${SR_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"write_gas_config":true}')"
echo "${RESP}"

if echo "${RESP}" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('ok') else 1)" 2>/dev/null; then
  echo ""
  echo "Done. スプレッドシートの「設定」タブ B2/B3 に書き込み済み。GAS は再読み込みだけで OK。"
  exit 0
fi

CFG="$(fetch_config)"
echo ""
echo "Sheet write failed."

if echo "${RESP}" | grep -q 'SERVICE_DISABLED\|Sheets API has not been used'; then
  echo "${CFG}" | python3 -c "import json,sys; d=json.load(sys.stdin); print('Enable Sheets API:', d.get('sheets_api_enable_url',''))" 2>/dev/null || true
fi

print_share_instructions "${CFG}"

if echo "${CFG}" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('ok') else 1)" 2>/dev/null; then
  echo ""
  echo "=== 手動フォールバック（設定タブ）==="
  echo "${CFG}" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('B2:', d['supabase_receipt_sheets_sync_url'])
print('B3:', d['receipt_sheets_sync_secret'])
"
fi

exit 1
