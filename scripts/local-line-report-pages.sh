#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVE_ROOT="${ROOT}/.local/pages-preview"
SITE_LINK="${SERVE_ROOT}/line_report"

mkdir -p "${SERVE_ROOT}"
ln -sfn "${ROOT}/public" "${SITE_LINK}"

PORT="${PORT:-8765}"
BASE_URL="http://127.0.0.1:${PORT}/line_report/"

if command -v lsof >/dev/null 2>&1; then
  if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port ${PORT} is already in use (server may already be running)."
    echo ""
    echo "Open in browser:"
    echo "  ${BASE_URL}index.html"
    echo ""
    echo "Use another port: PORT=8785 $0"
    exit 0
  fi
fi

echo "Serving ${SERVE_ROOT} at ${BASE_URL}"
echo "  管理画面: ${BASE_URL}index.html"
echo "  売上分析: ${BASE_URL}analytics.html"
echo "  トーク:   ${BASE_URL}chat.html"
echo "  システムマップ: ${BASE_URL}system-map.html"
echo "  メディア:   ${BASE_URL}media.html"
echo "  予約表:   ${BASE_URL}reservation.html"
echo ""
echo "Important: use http:// (NOT https://)"
echo "Ctrl+C to stop"

cd "${SERVE_ROOT}"
exec python3 -m http.server "${PORT}"
