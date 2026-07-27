# Graphify × Obsidian × AI Knowledge System — LINE Report

## Canonical files
- `knowledge/system-architecture.json`: 本番・業務AI・知識循環の構成モデル。
- `scripts/generate-knowledge-system.mjs`: Web/Obsidian/AI文書生成。
- `AGENTS.md`: AI必須ルール。
- `PROJECT_PROGRESS.md` / `AI_HANDOFF.md`: 現在地と引き継ぎ。
- `docs/SECURITY.md`: セキュリティ不変条件の既存正本。

## Generated outputs
- `public/system-map/graph.html`: Graphifyコード/SQLグラフ。
- `public/system-map/environment.html`: 3層環境図。
- `public/system-map/graph-stats.json`: ノード/関係/SQL coverage。
- `docs/AI_CONTEXT.md`: AI向け短縮コンテキスト。
- Obsidian `70_AI作業環境/`: AI入口・図・ルール・チェックリスト。
- Obsidian `80_リポジトリ文書/`: README/docsの自動ミラー。
- Obsidian `90_Graphify/`: コード/SQLの自動ノート。

## Development loop
1. Obsidianと既存docsを検索。
2. knowledge:checkで鮮度・SQL coverageを確認。
3. Graphifyで関数・SQL・経路を特定。
4. HTMLインラインJS、認証・店舗スコープ、外部サービスを直接確認。
5. 実装・テスト・ローカルUI・本番を検証。
6. 手書き知識と既存運用ログへ結果を書き戻す。
7. knowledge:updateで全出力を同期。
