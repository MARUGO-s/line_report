#!/usr/bin/env bash

set -euo pipefail

graphify_bin="$(command -v graphify || true)"
if [[ -z "$graphify_bin" ]]; then
  echo "Graphify CLI is required." >&2
  exit 1
fi

python_bin="$(head -1 "$graphify_bin" | sed 's/^#!//')"
if [[ ! -x "$python_bin" ]]; then
  echo "Could not resolve Graphify Python interpreter from $graphify_bin" >&2
  exit 1
fi

required_version="0.3.11"
if "$python_bin" -c "import tree_sitter_sql; from importlib.metadata import version; raise SystemExit(0 if version('tree-sitter-sql') == '$required_version' else 1)" >/dev/null 2>&1; then
  exit 0
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "tree-sitter-sql is required for migration/RLS coverage. Install uv, then run:" >&2
  echo "  uv pip install --python \"$python_bin\" tree-sitter-sql" >&2
  exit 1
fi

echo "[knowledge] installing Graphify SQL parser into its isolated Python environment..."
uv pip install --python "$python_bin" "tree-sitter-sql==$required_version"
