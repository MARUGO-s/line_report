#!/usr/bin/env bash
# 本番の過去売上同期トグル（journalSalesSync）を動作確認する。
# 前提: supabase link 済み（SUPABASE_ACCESS_TOKEN / DB password）
# 秘密値・顧客データ・メッセージ本文は出力しない。
set -euo pipefail

PROJECT_REF="${PROJECT_REF:-hocbnifuactbvmyjraxy}"
ADMIN_API="https://${PROJECT_REF}.supabase.co/functions/v1/admin-api"
PAGES_URL="${PAGES_URL:-https://marugo-s.github.io/line_report/jnm/index.html}"
TEST_STORE="${TEST_STORE:-sauvage}"
EXPECT_ON_STORE="${EXPECT_ON_STORE:-bistrocavacava}"

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "OK  $*"; }
bad() { fail=$((fail + 1)); echo "FAIL $*"; }

echo "=== 1) Pages HTML: sync switch present ==="
html="$(curl -fsS "${PAGES_URL}?nocache=$(date +%s)")"
if grep -q 'id="opsJournalSalesSync"' <<<"$html" \
  && grep -q '過去売上への同期（ジャーナルを正とする）' <<<"$html" \
  && grep -q "journalSalesSync: !!document.getElementById('opsJournalSalesSync')" <<<"$html" \
  && grep -q 'journalSalesSync: keepSync' <<<"$html"; then
  ok "Pages markup + read/reset wiring"
else
  bad "Pages missing sync switch wiring"
fi

echo "=== 2) DB: only expected store has journalSalesSync=true ==="
on_stores_json="$(supabase db query --linked --output json "
  select store_partition_key
  from public.store_operation_profiles
  where coalesce(profile->>'journalSalesSync','') = 'true'
  order by 1;
")"
on_keys="$(python3 -c '
import json, sys
data = json.loads(sys.argv[1])
rows = data if isinstance(data, list) else data.get("data") or data.get("rows") or []
keys = []
for row in rows:
    if isinstance(row, dict):
        keys.append(str(row.get("store_partition_key") or next(iter(row.values()), "")))
    elif isinstance(row, list) and row:
        keys.append(str(row[0]))
print(",".join(k for k in keys if k))
' "$on_stores_json")"
if [[ "$on_keys" == "$EXPECT_ON_STORE" ]]; then
  ok "DB ON stores == ${EXPECT_ON_STORE}"
else
  bad "DB ON stores expected '${EXPECT_ON_STORE}' got '${on_keys}'"
fi

echo "=== 3) Resolve cron auth token (value not printed) ==="
token="$(python3 -c '
import json, subprocess, sys
q = "select public.resolve_edge_cron_auth_token() as token;"
out = subprocess.check_output(
    ["supabase", "db", "query", "--linked", "--output", "json", q],
    text=True,
)
data = json.loads(out)
rows = data if isinstance(data, list) else data.get("data") or data.get("rows") or []
token = ""
if rows:
    row = rows[0]
    if isinstance(row, dict):
        token = str(row.get("token") or row.get("TOKEN") or next(iter(row.values()), "")).strip()
    elif isinstance(row, list) and row:
        token = str(row[0]).strip()
if not token:
    sys.stderr.write("cron auth token empty\n")
    sys.exit(1)
print(token, end="")
')"
ok "cron auth token resolved"

api_get() {
  local store="$1"
  curl -fsS \
    -H "Authorization: Bearer ${token}" \
    "${ADMIN_API}/pos-journals/store-ops?store_key=${store}"
}

api_post() {
  local body="$1"
  curl -fsS \
    -X POST \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json; charset=utf-8" \
    -d "$body" \
    "${ADMIN_API}/pos-journals/store-ops"
}

echo "=== 4) API GET ${EXPECT_ON_STORE} (expect ON) ==="
cava_json="$(api_get "$EXPECT_ON_STORE")"
if python3 -c '
import json, sys
body = json.loads(sys.argv[1])
assert body.get("ok") is True
profile = body.get("profile") or {}
assert profile.get("journalSalesSync") is True, profile
' "$cava_json"; then
  ok "${EXPECT_ON_STORE} journalSalesSync=true"
else
  bad "${EXPECT_ON_STORE} GET sync flag"
fi

echo "=== 5) API round-trip on ${TEST_STORE} (restore afterward) ==="
orig_json="$(api_get "$TEST_STORE")"
if python3 -c '
import json, sys
body = json.loads(sys.argv[1])
assert body.get("ok") is True
' "$orig_json"; then
  ok "${TEST_STORE} GET ok"
else
  bad "${TEST_STORE} GET failed"
fi

restore_body="$(python3 -c '
import json, sys
body = json.loads(sys.argv[1])
store = sys.argv[2]
profile = body.get("profile")
if not isinstance(profile, dict):
    profile = {
        "closedWeekdays": [],
        "overflowRule": False,
        "overflowThreshold": 8,
        "overflowOpenWeekday": "月",
        "lunchOffered": "yes",
        "dinnerOffered": "yes",
        "specialOpenPolicy": "",
        "notes": "",
        "journalSalesSync": False,
    }
print(json.dumps({"store_key": store, "profile": profile}, ensure_ascii=False))
' "$orig_json" "$TEST_STORE")"

cleanup() {
  if [[ -n "${restore_body:-}" ]]; then
    echo "=== cleanup: restore ${TEST_STORE} profile ==="
    api_post "$restore_body" >/dev/null || echo "WARN restore failed"
  fi
}
trap cleanup EXIT

on_body="$(python3 -c '
import json, sys
body = json.loads(sys.argv[1])
body["profile"]["journalSalesSync"] = True
print(json.dumps(body, ensure_ascii=False))
' "$restore_body")"
api_post "$on_body" >/dev/null
after_on="$(api_get "$TEST_STORE")"
if python3 -c '
import json, sys
p = (json.loads(sys.argv[1]).get("profile") or {})
assert p.get("journalSalesSync") is True
' "$after_on"; then
  ok "${TEST_STORE} save ON → reload ON"
else
  bad "${TEST_STORE} save ON"
fi

off_body="$(python3 -c '
import json, sys
body = json.loads(sys.argv[1])
body["profile"]["journalSalesSync"] = False
print(json.dumps(body, ensure_ascii=False))
' "$restore_body")"
api_post "$off_body" >/dev/null
after_off="$(api_get "$TEST_STORE")"
if python3 -c '
import json, sys
p = (json.loads(sys.argv[1]).get("profile") or {})
assert p.get("journalSalesSync") is False
' "$after_off"; then
  ok "${TEST_STORE} save OFF → reload OFF"
else
  bad "${TEST_STORE} save OFF"
fi

api_post "$on_body" >/dev/null
omit_body="$(python3 -c '
import json, sys
body = json.loads(sys.argv[1])
profile = dict(body["profile"])
profile.pop("journalSalesSync", None)
print(json.dumps({"store_key": body["store_key"], "profile": profile}, ensure_ascii=False))
' "$restore_body")"
api_post "$omit_body" >/dev/null
after_omit="$(api_get "$TEST_STORE")"
if python3 -c '
import json, sys
p = (json.loads(sys.argv[1]).get("profile") or {})
assert p.get("journalSalesSync") is True
' "$after_omit"; then
  ok "${TEST_STORE} omit key keeps ON"
else
  bad "${TEST_STORE} omit key preserve"
fi

cava_again="$(api_get "$EXPECT_ON_STORE")"
if python3 -c '
import json, sys
p = (json.loads(sys.argv[1]).get("profile") or {})
assert p.get("journalSalesSync") is True
' "$cava_again"; then
  ok "${EXPECT_ON_STORE} still ON"
else
  bad "${EXPECT_ON_STORE} changed"
fi

cleanup
trap - EXIT

echo
echo "PASS=${pass} FAIL=${fail}"
if [[ "$fail" -gt 0 ]]; then
  exit 1
fi
echo "All journalSalesSync toggle behavior checks passed."
