#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVE_ROOT="$(dirname "$ROOT")"
LINK_NAME="line_report"
LINK_PATH="${SERVE_ROOT}/${LINK_NAME}"

# 常に line_report-main → line_report のシンボリックリンクを維持（終了時に削除しない）
if [[ "$(basename "${ROOT}")" != "${LINK_NAME}" ]]; then
  if [[ -e "${LINK_PATH}" && ! -L "${LINK_PATH}" ]]; then
    echo "Error: ${LINK_PATH} exists and is not a symlink." >&2
    exit 1
  fi
  ln -sfn "$(basename "${ROOT}")" "${LINK_PATH}"
fi

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
echo "  メディア:   ${BASE_URL}media.html"
echo "  予約表:   ${BASE_URL}reservation.html"
echo ""
echo "Important: use http:// (NOT https://)"
echo "Ctrl+C to stop"

cd "${SERVE_ROOT}"
exec python3 -m http.server "${PORT}"
