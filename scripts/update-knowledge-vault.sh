#!/usr/bin/env bash

set -euo pipefail

# Update the Graphify + Obsidian + AI knowledge environment for LINE Report.
# Graphify covers application code and SQL migrations; vendor/generated/secret
# paths are excluded by .graphifyignore.

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir"

# Vault app and Graphify output folders. Override these on another machine.
vault_app_dir="${KNOWLEDGE_VAULT_APP_DIR:-/Users/yoshito/Library/CloudStorage/Dropbox/web/アプリ知識/10_アプリ別/LINE Report}"
vault_graphify_dir="${KNOWLEDGE_VAULT_GRAPHIFY_DIR:-$vault_app_dir/90_Graphify}"
export KNOWLEDGE_VAULT_APP_DIR="$vault_app_dir"
export KNOWLEDGE_VAULT_GRAPHIFY_DIR="$vault_graphify_dir"

if ! command -v graphify >/dev/null 2>&1; then
  echo "Graphify CLI is required. Install it before updating the knowledge vault." >&2
  exit 1
fi

echo "[knowledge] refreshing LINE Report code + SQL graph..."
npm run graphify:system-map

echo "[knowledge] exporting Obsidian notes to vault..."
mkdir -p "$vault_graphify_dir"
graphify export obsidian --dir "$vault_graphify_dir"
# This directory is a generated subfolder inside the main "アプリ知識" Vault,
# not an independent nested Vault.
rm -rf "$vault_graphify_dir/.obsidian"

echo "[knowledge] generating runtime, business AI, and development knowledge views..."
node scripts/generate-knowledge-system.mjs

echo "[knowledge] validating Graphify, repository outputs, and Obsidian..."
node scripts/check-knowledge-system.mjs

echo "[knowledge] done"
echo "[knowledge] Graphify notes: $vault_graphify_dir"
echo "[knowledge] AI workspace: $vault_app_dir/70_AI作業環境"
