#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVE_ROOT="$(dirname "$ROOT")"
LINK_NAME="line_report"
LINK_PATH="${SERVE_ROOT}/${LINK_NAME}"
CREATED_LINK=0

cleanup() {
  if [[ "${CREATED_LINK}" -eq 1 ]]; then
    rm -f "${LINK_PATH}"
  fi
}
trap cleanup EXIT

if [[ "$(basename "${ROOT}")" != "${LINK_NAME}" ]]; then
  if [[ -e "${LINK_PATH}" && ! -L "${LINK_PATH}" ]]; then
    echo "Error: ${LINK_PATH} exists and is not a symlink." >&2
    exit 1
  fi
  ln -sfn "$(basename "${ROOT}")" "${LINK_PATH}"
  CREATED_LINK=1
fi

PORT="${PORT:-8765}"

echo "Serving ${SERVE_ROOT} at http://127.0.0.1:${PORT}/line_report/"
echo "  管理画面: http://127.0.0.1:${PORT}/line_report/index.html"
echo "  売上分析: http://127.0.0.1:${PORT}/line_report/analytics.html"
echo "  メディア: http://127.0.0.1:${PORT}/line_report/media.html"
echo "  予約表:   http://127.0.0.1:${PORT}/line_report/reservation.html"
echo "Ctrl+C で停止"

cd "${SERVE_ROOT}"
exec python3 -m http.server "${PORT}"
