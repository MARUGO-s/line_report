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
graph_node_count="$(
  node -e "const fs=require('fs');const g=JSON.parse(fs.readFileSync('graphify-out/graph.json','utf8'));process.stdout.write(String((g.nodes||[]).length))"
)"
if (( graph_node_count > 5000 )); then
  echo "[graphify] generating a large public graph (${graph_node_count} nodes)."
  GRAPHIFY_VIZ_NODE_LIMIT="$((graph_node_count + 500))" graphify cluster-only . --no-label
else
  graphify cluster-only . --no-label
fi

mkdir -p public/system-map
cp graphify-out/graph.html public/system-map/graph.html
cp graphify-out/GRAPH_REPORT.md public/system-map/GRAPH_REPORT.md
