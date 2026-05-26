#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVE_ROOT="$(dirname "${ROOT}")"
LINK_PATH="${SERVE_ROOT}/line_report"
PORTS=(8765 8785)
URL=""

ln -sfn "$(basename "${ROOT}")" "${LINK_PATH}" 2>/dev/null || true

start_port() {
  local port="$1"
  if lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
    return 0
  fi
  echo "Starting local server on port ${port}..."
  (cd "${SERVE_ROOT}" && nohup python3 -m http.server "${port}" >/tmp/line-report-pages-${port}.log 2>&1 &)
  sleep 0.4
}

for port in "${PORTS[@]}"; do
  start_port "${port}"
  if curl -fsS -o /dev/null "http://127.0.0.1:${port}/line_report/index.html" 2>/dev/null; then
    URL="http://127.0.0.1:${port}/line_report/index.html"
    break
  fi
done

if [[ -z "${URL}" ]]; then
  echo "Could not start local server. Run manually:" >&2
  echo "  cd ${ROOT} && ./scripts/local-line-report-pages.sh" >&2
  exit 1
fi

echo "Open: ${URL}"
if command -v open >/dev/null 2>&1; then
  open "${URL}"
fi
