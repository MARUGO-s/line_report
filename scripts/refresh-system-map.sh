#!/usr/bin/env bash

set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir"

bash scripts/ensure-graphify-sql-parser.sh

graphify extract . --code-only --out .
if ! node scripts/check-graphify-sql-coverage.mjs; then
  echo "[graphify] retrying a full extraction after SQL parser/cache change..."
  graphify extract . --code-only --out . --force
  node scripts/check-graphify-sql-coverage.mjs
fi
graphify cluster-only . --no-label

mkdir -p system-map
cp graphify-out/graph.html system-map/graph.html
cp graphify-out/GRAPH_REPORT.md system-map/GRAPH_REPORT.md
