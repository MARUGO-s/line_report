import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const projectDir = fileURLToPath(new URL("../", import.meta.url));
const modelPath = join(projectDir, "knowledge/system-architecture.json");
const graphPath = join(projectDir, "graphify-out/graph.json");
const publicDir = join(projectDir, "public/system-map");
const docsDir = join(projectDir, "docs");

const vaultAppDir =
  process.env.KNOWLEDGE_VAULT_APP_DIR ??
  "/Users/yoshito/Library/CloudStorage/Dropbox/web/アプリ知識/10_アプリ別/LINE Report";
const vaultGraphifyDir =
  process.env.KNOWLEDGE_VAULT_GRAPHIFY_DIR ??
  join(vaultAppDir, "90_Graphify");
const vaultAiDir = join(vaultAppDir, "70_AI作業環境");
const vaultRepoDocsDir = join(vaultAppDir, "80_リポジトリ文書");

const model = JSON.parse(await readFile(modelPath, "utf8"));
const graph = JSON.parse(await readFile(graphPath, "utf8"));
const stats = {
  nodes: graph.nodes?.length ?? 0,
  edges: graph.links?.length ?? 0,
  communities: new Set(
    (graph.nodes ?? [])
      .map((node) => node.community)
      .filter((community) => community !== undefined && community !== null),
  ).size,
  builtAtCommit: graph.built_at_commit ?? "unknown",
  sqlNodes: (graph.nodes ?? []).filter((node) =>
    String(node.source_file ?? "").endsWith(".sql"),
  ).length,
  sqlFiles: new Set(
    (graph.nodes ?? [])
      .filter((node) => String(node.source_file ?? "").endsWith(".sql"))
      .map((node) => node.source_file),
  ).size,
};
const generatedAt = new Date().toISOString();

await Promise.all([
  mkdir(publicDir, { recursive: true }),
  mkdir(docsDir, { recursive: true }),
  mkdir(vaultAiDir, { recursive: true }),
  mkdir(vaultGraphifyDir, { recursive: true }),
  mkdir(vaultRepoDocsDir, { recursive: true }),
]);

const colors = {
  people: "#5b7cfa",
  frontend: "#14b8a6",
  hosting: "#0ea5e9",
  delivery: "#8b5cf6",
  supabase: "#22c55e",
  edge: "#10b981",
  google: "#f59e0b",
  security: "#ef4444",
  storage: "#64748b",
  ai: "#a855f7",
  knowledge: "#2563eb",
  graph: "#06b6d4",
  code: "#334155",
  obsidian: "#7c3aed",
  automation: "#f97316",
  line: "#06c755",
  data: "#22c55e",
  legacy: "#64748b",
};

const edgeColors = {
  user: "#93c5fd",
  delivery: "#c4b5fd",
  backup: "#94a3b8",
  auth: "#67e8f9",
  data: "#86efac",
  secret: "#fca5a5",
  job: "#fdba74",
  knowledge: "#c4b5fd",
  query: "#67e8f9",
  generation: "#a7f3d0",
  code: "#cbd5e1",
  writeback: "#f0abfc",
  automation: "#fdba74",
  ai: "#f0abfc",
  legacy: "#94a3b8",
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeXml(value) {
  return escapeHtml(value).replaceAll("'", "&apos;");
}

function splitLabel(value) {
  return String(value).split(/\n/);
}

function renderSvg(view) {
  const nodes = model.nodes.filter((node) => node.view === view.id);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges = model.edges.filter(
    (edge) =>
      edge.view === view.id &&
      nodeById.has(edge.from) &&
      nodeById.has(edge.to),
  );
  const markerIds = [...new Set(edges.map((edge) => edge.kind))];

  const defs = markerIds
    .map(
      (kind) => `
      <marker id="arrow-${kind}" viewBox="0 0 10 10" refX="9" refY="5"
        markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="${edgeColors[kind] ?? "#94a3b8"}" />
      </marker>`,
    )
    .join("");

  const edgeSvg = edges
    .map((edge) => {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      const startX = from.x + from.width / 2;
      const startY = from.y + from.height / 2;
      const endX = to.x + to.width / 2;
      const endY = to.y + to.height / 2;
      const deltaX = endX - startX;
      const deltaY = endY - startY;
      const horizontal = Math.abs(deltaX) >= Math.abs(deltaY);
      const x1 =
        startX +
        (horizontal
          ? Math.sign(deltaX || 1) * (from.width / 2 + 4)
          : 0);
      const y1 =
        startY +
        (!horizontal
          ? Math.sign(deltaY || 1) * (from.height / 2 + 4)
          : 0);
      const x2 =
        endX -
        (horizontal ? Math.sign(deltaX || 1) * (to.width / 2 + 10) : 0);
      const y2 =
        endY -
        (!horizontal ? Math.sign(deltaY || 1) * (to.height / 2 + 10) : 0);
      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2;
      return `
        <g class="edge edge-${edge.kind}">
          <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"
            stroke="${edgeColors[edge.kind] ?? "#94a3b8"}"
            stroke-width="2.2" marker-end="url(#arrow-${edge.kind})" />
          <rect x="${midX - 70}" y="${midY - 12}" width="140" height="24"
            rx="7" fill="#0f172a" fill-opacity=".92" />
          <text x="${midX}" y="${midY + 4}" text-anchor="middle"
            fill="#dbeafe" font-size="12" font-weight="650">${escapeXml(edge.label)}</text>
        </g>`;
    })
    .join("");

  const nodeSvg = nodes
    .map((node) => {
      const color = colors[node.group] ?? "#64748b";
      const titleLines = splitLabel(node.label);
      const titleStart =
        node.y + 30 - ((titleLines.length - 1) * 9);
      const title = titleLines
        .map(
          (line, index) =>
            `<tspan x="${node.x + node.width / 2}" dy="${index ? 20 : 0}">${escapeXml(line)}</tspan>`,
        )
        .join("");
      const description = escapeXml(node.description);
      return `
        <g class="node" data-node-id="${escapeXml(node.id)}">
          <rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}"
            rx="14" fill="#111827" stroke="${color}" stroke-width="2.5" />
          <rect x="${node.x}" y="${node.y}" width="8" height="${node.height}"
            rx="4" fill="${color}" />
          <text x="${node.x + node.width / 2}" y="${titleStart}" text-anchor="middle"
            fill="#f8fafc" font-size="15" font-weight="800">${title}</text>
          <foreignObject x="${node.x + 18}" y="${node.y + 58}"
            width="${node.width - 36}" height="${Math.max(30, node.height - 68)}">
            <div xmlns="http://www.w3.org/1999/xhtml"
              style="color:#aebbd0;font:12px/1.35 system-ui;text-align:center;overflow:hidden">
              ${description}
            </div>
          </foreignObject>
        </g>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${view.width} ${view.height}" role="img"
    aria-labelledby="${view.id}-title ${view.id}-desc"
    xmlns="http://www.w3.org/2000/svg">
    <title id="${view.id}-title">${escapeXml(view.title)}</title>
    <desc id="${view.id}-desc">${escapeXml(view.description)}</desc>
    <defs>${defs}</defs>
    <rect width="${view.width}" height="${view.height}" fill="#07111f" />
    <text x="40" y="42" fill="#f8fafc" font-size="25" font-weight="850">${escapeXml(view.title)}</text>
    <text x="40" y="66" fill="#94a3b8" font-size="13">${escapeXml(view.description)}</text>
    ${edgeSvg}
    ${nodeSvg}
  </svg>`;
}

const viewSections = model.views
  .map(
    (view, index) => `
      <section class="diagram-panel ${index === 0 ? "is-active" : ""}" data-diagram-panel="${view.id}">
        ${renderSvg(view)}
      </section>`,
  )
  .join("");

const architectureHtml = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(model.project.name)} 環境図</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, "Noto Sans JP", system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #050a12; color: #f8fafc; }
    .shell { margin: 0 auto; max-width: 1580px; padding: 24px; }
    .header { align-items: flex-end; display: flex; gap: 20px; justify-content: space-between; margin-bottom: 18px; }
    .eyebrow { color: #67e8f9; font-size: 12px; font-weight: 850; letter-spacing: .12em; margin: 0 0 7px; text-transform: uppercase; }
    h1 { font-size: clamp(24px, 4vw, 38px); margin: 0; }
    .summary { color: #94a3b8; font-size: 13px; margin: 8px 0 0; max-width: 840px; }
    .stats { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; min-width: 0; }
    .stat { background: #111827; border: 1px solid #25324a; border-radius: 10px; color: #cbd5e1; font-size: 12px; font-weight: 750; max-width: 100%; padding: 9px 11px; white-space: nowrap; }
    .tabs { display: flex; gap: 8px; margin-bottom: 14px; max-width: 100%; overflow-x: auto; padding-bottom: 3px; }
    .tab { background: #111827; border: 1px solid #334155; border-radius: 9px; color: #cbd5e1; cursor: pointer; flex: 0 0 auto; font: inherit; font-size: 13px; font-weight: 800; padding: 10px 14px; white-space: nowrap; }
    .tab.is-active { background: #1d4ed8; border-color: #60a5fa; color: white; }
    .diagram-panel { background: #07111f; border: 1px solid #26344d; border-radius: 14px; display: none; overflow: auto; }
    .diagram-panel.is-active { display: block; }
    svg { display: block; height: auto; min-width: 1050px; width: 100%; }
    .guide { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); margin-top: 16px; }
    .guide article { background: #0f172a; border: 1px solid #273449; border-radius: 12px; padding: 15px; }
    .guide h2 { font-size: 14px; margin: 0 0 8px; }
    .guide p { color: #9fb0c8; font-size: 12px; line-height: 1.6; margin: 0; }
    code { color: #67e8f9; }
    @media (max-width: 720px) {
      .shell { padding: 14px; }
      .header { align-items: flex-start; flex-direction: column; min-width: 0; width: 100%; }
      .stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); justify-content: stretch; width: 100%; }
      .stat { font-size: 11px; overflow-wrap: anywhere; white-space: normal; }
      .stat:last-child { grid-column: 1 / -1; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="header">
      <div>
        <p class="eyebrow">Graphify × Obsidian × AI</p>
        <h1>${escapeHtml(model.project.name)} 環境図</h1>
        <p class="summary">実行環境と、AIがGraphify・Obsidianを使って探索・実装・検証・知識保存する循環を、同じ構造モデルから生成しています。</p>
      </div>
      <div class="stats">
        <span class="stat">${stats.nodes} Graphify nodes</span>
        <span class="stat">${stats.edges} relationships</span>
        <span class="stat">${stats.communities} communities</span>
        <span class="stat">${stats.sqlFiles} SQL files / ${stats.sqlNodes} nodes</span>
        <span class="stat">generated ${escapeHtml(generatedAt.slice(0, 10))}</span>
      </div>
    </header>
    <nav class="tabs" aria-label="環境図の切替">
      ${model.views
        .map(
          (view, index) =>
            `<button class="tab ${index === 0 ? "is-active" : ""}" type="button" data-diagram-tab="${view.id}">${escapeHtml(view.title)}</button>`,
        )
        .join("")}
    </nav>
    ${viewSections}
    <section class="guide">
      <article><h2>AIの開始点</h2><p><code>AGENTS.md</code> → Obsidianの<code>00_AI_START_HERE</code> → <code>knowledge:search</code> → <code>knowledge:check</code>。</p></article>
      <article><h2>コード・SQL探索</h2><p>Graphifyのquery/path/explainでJS/TS/Python/Shell/SQLを絞り、HTMLインラインJSや外部境界は直接確認します。</p></article>
      <article><h2>既存文書の活用</h2><p>README・SECURITY・運用ログ・AI設計書をObsidianの80_リポジトリ文書へ自動ミラーします。</p></article>
      <article><h2>更新</h2><p>構造変更後に<code>npm run knowledge:update</code>。検査は<code>npm run knowledge:check</code>。</p></article>
    </section>
  </main>
  <script>
    const tabs = [...document.querySelectorAll("[data-diagram-tab]")];
    const panels = [...document.querySelectorAll("[data-diagram-panel]")];
    function activate(id, updateHash = false) {
      const selected = tabs.find((tab) => tab.dataset.diagramTab === id) ?? tabs[0];
      if (!selected) return;
      tabs.forEach((item) => item.classList.toggle("is-active", item === selected));
      panels.forEach((panel) => panel.classList.toggle("is-active", panel.dataset.diagramPanel === selected.dataset.diagramTab));
      if (updateHash) history.replaceState(null, "", "#" + selected.dataset.diagramTab);
    }
    for (const tab of tabs) {
      tab.addEventListener("click", () => {
        activate(tab.dataset.diagramTab, true);
      });
    }
    activate(location.hash.replace(/^#/, "") || "runtime");
  </script>
</body>
</html>`;

function mermaid(viewId) {
  const nodes = model.nodes.filter((node) => node.view === viewId);
  const ids = new Set(nodes.map((node) => node.id));
  const edges = model.edges.filter(
    (edge) =>
      edge.view === viewId && ids.has(edge.from) && ids.has(edge.to),
  );
  const lines = ["flowchart LR"];
  for (const node of nodes) {
    lines.push(
      `  ${node.id}["${String(node.label).replaceAll("\n", "<br/>").replaceAll('"', "'")}"]`,
    );
  }
  for (const edge of edges) {
    lines.push(
      `  ${edge.from} -->|"${String(edge.label).replaceAll('"', "'")}"| ${edge.to}`,
    );
  }
  return lines.join("\n");
}

function canvasForView(viewId) {
  const nodes = model.nodes.filter((node) => node.view === viewId);
  const ids = new Set(nodes.map((node) => node.id));
  const edges = model.edges.filter(
    (edge) =>
      edge.view === viewId && ids.has(edge.from) && ids.has(edge.to),
  );
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: "text",
      text: `# ${node.label}\n\n${node.description}`,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      color: colors[node.group] ?? "#64748b",
    })),
    edges: edges.map((edge, index) => ({
      id: `${viewId}-edge-${index}`,
      fromNode: edge.from,
      fromSide: "right",
      toNode: edge.to,
      toSide: "left",
      label: edge.label,
    })),
  };
}

const sourcePriorityTable = model.sourcePriority
  .map(
    (item) =>
      `| ${item.rank} | ${item.source} | ${item.use} | ${item.warning} |`,
  )
  .join("\n");

const aiContext = `# AI Knowledge Context

Generated from \`knowledge/system-architecture.json\` and the current Graphify graph.

## Project
- Name: ${model.project.name}
- Working directory: \`${model.project.workingDirectory}\`
- Repository: ${model.project.repository}
- Production: ${model.project.productionUrl}
- Supabase: ${model.project.supabaseProjectRef}
- Graphify: ${stats.nodes} nodes / ${stats.edges} relationships / ${stats.communities} communities
- SQL coverage: ${stats.sqlFiles} files / ${stats.sqlNodes} nodes
- Generated: ${generatedAt}

## Required workflow
1. Read \`AGENTS.md\`, \`PROJECT_PROGRESS.md\`, \`AI_HANDOFF.md\`, \`docs/AI_KNOWLEDGE_SYSTEM.md\`, and Obsidian \`70_AI作業環境/00_AI_START_HERE.md\`.
2. Search durable knowledge with \`npm run knowledge:search -- "<task or topic>"\`.
3. Run \`npm run knowledge:check\`.
4. Investigate with Graphify first: \`graphify query\`, \`graphify path\`, \`graphify explain\`.
5. Read only required source ranges. Directly inspect inline HTML/JS, SECURITY.md, runtime service boundaries, and live Supabase/GitHub/LINE state when relevant.
6. Run the relevant static checks and test groups; verify UI locally and Pages/API after deployment.
7. Write rationale/results to the relevant manual Obsidian note, repository docs, and \`PROJECT_PROGRESS.md\`.
8. After structural changes run \`npm run knowledge:update\`, then \`npm run knowledge:check\`.

## Source priority
| Rank | Source | Use | Warning |
|---:|---|---|---|
${sourcePriorityTable}

## Security boundary
Never place env files, private keys, service-role keys, LINE tokens, AI keys, Gmail credentials, customer data, message bodies, receipts, or uploaded media into Graphify, Obsidian, Git, screenshots, or chat.
`;

const aiStart = `---
type: ai-entrypoint
project: ${model.project.name}
generated: ${generatedAt}
graphify_nodes: ${stats.nodes}
graphify_edges: ${stats.edges}
graphify_sql_files: ${stats.sqlFiles}
---

# AI START HERE — ${model.project.name}

会話コンテキストだけに頼らず、既存設計書・運用ログ・Graphifyから必要な知識を復元して作業する。

## 作業開始（必須）
1. Git側の \`AGENTS.md\`、\`PROJECT_PROGRESS.md\`、\`AI_HANDOFF.md\`、\`docs/SECURITY.md\`、\`docs/AI_KNOWLEDGE_SYSTEM.md\` を読む。
2. \`npm run knowledge:search -- "<依頼・症状・機能名>"\`で手書き知識と\`80_リポジトリ文書\`を検索。
3. \`npm run knowledge:check\`でGraphify・SQL coverage・環境図・Vaultミラーを確認。
4. Graphifyでコード/SQLの場所と関係を特定する。

\`\`\`bash
graphify query "<自然言語の質問>"
graphify path "<A>" "<B>"
graphify explain "<関数・テーブル・migration>"
\`\`\`

Graphifyで対象を絞った後だけ、必要なソースを読む。静的HTML内のインラインJS、外部サービス境界、認証・店舗スコープは実装と既存文書を直接確認する。

## 環境図
- [[01_本番システム環境図]]
- [[02_業務データ_AI処理構成]]
- [[03_AI知識循環]]
- [[04_情報源と更新ルール]]
- [[05_AI作業チェックリスト]]
- [[06_Graphify_Obsidianブリッジ]]
- Canvas: \`runtime-system.canvas\` / \`business-ai-system.canvas\` / \`ai-knowledge-loop.canvas\`
- Web公開URL: \`system-map.html\`（ソース: \`public/system-map.html\`）

## 作業終了（必須）
1. 変更領域のNode構文/TypeScriptチェックと既存テスト群を実行。
2. UI変更は\`./scripts/local-line-report-pages.sh\`で実画面確認。
3. Supabase変更はmigration/Function/認証・401・RLS・Advisorsを確認。
4. 関連する手書きObsidianノート、\`docs/店舗運用修正記録.md\`、\`PROJECT_PROGRESS.md\`へ書き戻す。
5. \`npm run knowledge:update\` → \`npm run knowledge:check\` → \`git diff --check\`。
6. commit/push後、Pagesと必要なEdge Functions/DBの公開結果を確認。

## 自動生成領域
- \`80_リポジトリ文書\`: README/docsのミラー。手編集しない。
- \`90_Graphify\`: コード・SQLノート。手編集しない。
- 手書き知識は10〜70のフォルダへ保存する。
`;

const runtimeDoc = `# 本番システム環境図

GitHub Pages、Supabase hocbn、LINE、Google、AIプロバイダを結ぶ本番経路。

\`\`\`mermaid
${mermaid("runtime")}
\`\`\`

## セキュリティ境界
- GitHub Pagesは全世界公開前提。業務データはadmin-api/line-webhook等のEdge Function経由。
- admin-apiはlrst_セッション/生管理トークンと店舗・ルームスコープを検証。
- LINE Webhookは店舗別secretで署名をフェイルクローズ検証。
- DBはRLS、private Storageは署名URL/service_role経由。anonへSECURITY DEFINER実行権を渡さない。
- cronはCRON_AUTH_TOKEN/Vaultと各Function側ゲートを確認する。
`;

const businessDoc = `# 業務データ・AI処理構成

レシート、予約、会話検索、口コミ、フードコートAI、cronの業務フロー。

\`\`\`mermaid
${mermaid("business")}
\`\`\`

## 重要な分離
- 自店舗口コミは\`store_review_*\`、競合口コミは\`competitor_*\`で分離。
- 売上本体\`line_receipt__*\`と検索index\`line_room_receipt_search\`は別物。
- ルームメディア本体\`line-media\`と検索メタは別物。
- Gmail予約とLINE会話検索は別フロー。
- フードコートの予測モデル選択ループとAI回答品質ループは別ループ。
`;

const knowledgeDoc = `# AI・Graphify・Obsidian知識循環

既存設計書を活かしながら、コードとSQLをGraphifyで絞り、検証結果を永続知識へ戻す。

\`\`\`mermaid
${mermaid("knowledge")}
\`\`\`

## 役割分担
- **Graphify**: 現在のJS/TS/Python/Shell/SQL構造。${stats.sqlFiles} SQL files / ${stats.sqlNodes} nodesを含む。
- **80_リポジトリ文書**: README、SECURITY、店舗運用修正記録、AI設計書等の自動ミラー。
- **Obsidian手書き知識**: 意思決定、障害、機能別メモ、次回作業の背景。
- **実環境**: GitHub Pages、Supabase、LINE、AI APIの現在状態の証明。
`;

const sourceDoc = `# 情報源と更新ルール

## 優先順位
| 順位 | 情報源 | 用途 | 注意 |
|---:|---|---|---|
${sourcePriorityTable}

## 自動更新
\`\`\`bash
npm run knowledge:update
npm run knowledge:check
npm run knowledge:search -- "<タスク・症状・機能名>"
\`\`\`

- \`knowledge:update\`: Graphify、Web図、Obsidian Graphify、既存docsミラー、AI文書を更新。
- \`knowledge:check\`: manifest hash、SQL coverage、Web生成物、Vaultミラー、秘密値マーカーを検査。
- \`knowledge:search\`: 手書き知識と80_リポジトリ文書を検索。\`--all\`で90_Graphifyも含める。
`;

const checklistDoc = `# AI作業チェックリスト

## 開始
- [ ] \`AGENTS.md\` / \`PROJECT_PROGRESS.md\` / \`AI_HANDOFF.md\` / \`docs/SECURITY.md\`を読んだ
- [ ] [[00_AI_START_HERE]] と関連ノートを読んだ
- [ ] \`git status --short\`、branch、HEADを確認した
- [ ] \`npm run knowledge:search -- "<topic>"\`を実行した
- [ ] \`npm run knowledge:check\`が通った
- [ ] Graphify query/path/explainでコード/SQLを特定した

## 実装
- [ ] 静的HTMLインラインJS・Edge Function・migrationの対象範囲を確認した
- [ ] 店舗スコープ、room scope、LINE署名、cron認証、RLS不変条件を壊していない
- [ ] 既存の未commit変更を上書きしていない
- [ ] 秘密値・顧客/メッセージ/レシート実データを出力していない

## 終了
- [ ] Node/TypeScript構文チェックと関連テスト群が成功した
- [ ] UIをデスクトップ/モバイルで確認した
- [ ] APIは必要に応じて未認証401と認証後挙動を確認した
- [ ] Supabase変更時はmigration/Function deploy/Advisorsを確認した
- [ ] 手書きObsidian・店舗運用修正記録・進行記録へ書き戻した
- [ ] \`knowledge:update\` / \`knowledge:check\` / \`git diff --check\`が成功した
- [ ] commit / push / Pages・Edge Function公開確認を行った
`;

const bridgeDoc = `# Graphify × Obsidian ブリッジ

## 調査方法
1. \`npm run knowledge:search -- "<要件・症状・機能名>"\`
2. \`graphify query "<コード/SQL上で知りたいこと>"\`
3. \`graphify explain\` / \`graphify path\`
4. 該当ソースと実環境を確認し、手書き知識・運用ログへ書き戻す。

## 主要領域
| 領域 | 手書き/既存文書 | Graphifyノード |
|---|---|---|
| 管理認証・店舗スコープ | [[80_リポジトリ文書/docs/SECURITY|SECURITY]] | [[90_Graphify/authenticateAdminDashboardSessionToken()|authenticateAdminDashboardSessionToken()]] / [[90_Graphify/auth-session.js|auth-session.js]] |
| LINEレシート解析 | [[60_機能別知識/LINEレシート解析|LINEレシート解析]] / [[80_リポジトリ文書/docs/LINE-RECEIPT-ANALYSIS|LINE-RECEIPT-ANALYSIS]] | [[90_Graphify/processReceiptImageEvent()|processReceiptImageEvent()]] |
| 売上分析・口コミ | [[60_機能別知識/売上分析と口コミ|売上分析と口コミ]] | [[90_Graphify/fetchReceiptSalesState()|fetchReceiptSalesState()]] / [[90_Graphify/competitor_review_context.ts|competitor_review_context.ts]] |
| 予約・Gmail | [[80_リポジトリ文書/docs/RESERVATION-GMAIL-GUIDE|予約Gmailガイド]] | [[90_Graphify/gmail-alert-cron/index.ts|gmail-alert-cron/index.ts]] |
| フードコートAI | [[60_機能別知識/フードコートAI|フードコートAI]] / [[80_リポジトリ文書/docs/フードコートAI学習・自己進化システム_完全設計書|完全設計書]] | [[90_Graphify/generateFoodCourtWeeklyReport()|generateFoodCourtWeeklyReport()]] / [[90_Graphify/foodcourt_compare.ts|foodcourt_compare.ts]] |
| RLS・migration | [[80_リポジトリ文書/docs/SECURITY|SECURITY]] | [[90_Graphify/20260612100000_enable_rls_security_tables.sql|RLS migration]] |
| 知識更新 | [[04_情報源と更新ルール]] | [[90_Graphify/update-knowledge-vault.sh|update-knowledge-vault.sh]] |

## Graphifyで補完が必要な領域
- 静的HTML内の大きなインラインJSはGraphifyノードにならないため、対象HTMLを直接確認。
- GitHub Actions、Supabase Secrets、LINE Developers、AIプロバイダの現在状態は実環境で確認。
- 設計意図・運用事故・既知の警告は80_リポジトリ文書と手書きノートを優先。
`;

const systemDoc = `# Graphify × Obsidian × AI Knowledge System — LINE Report

## Canonical files
- \`knowledge/system-architecture.json\`: 本番・業務AI・知識循環の構成モデル。
- \`scripts/generate-knowledge-system.mjs\`: Web/Obsidian/AI文書生成。
- \`AGENTS.md\`: AI必須ルール。
- \`PROJECT_PROGRESS.md\` / \`AI_HANDOFF.md\`: 現在地と引き継ぎ。
- \`docs/SECURITY.md\`: セキュリティ不変条件の既存正本。

## Generated outputs
- \`public/system-map/graph.html\`: Graphifyコード/SQLグラフ。
- \`public/system-map/environment.html\`: 3層環境図。
- \`public/system-map/graph-stats.json\`: ノード/関係/SQL coverage。
- \`docs/AI_CONTEXT.md\`: AI向け短縮コンテキスト。
- Obsidian \`70_AI作業環境/\`: AI入口・図・ルール・チェックリスト。
- Obsidian \`80_リポジトリ文書/\`: README/docsの自動ミラー。
- Obsidian \`90_Graphify/\`: コード/SQLの自動ノート。

## Development loop
1. Obsidianと既存docsを検索。
2. knowledge:checkで鮮度・SQL coverageを確認。
3. Graphifyで関数・SQL・経路を特定。
4. HTMLインラインJS、認証・店舗スコープ、外部サービスを直接確認。
5. 実装・テスト・ローカルUI・本番を検証。
6. 手書き知識と既存運用ログへ結果を書き戻す。
7. knowledge:updateで全出力を同期。
`;

const graphStats = { ...stats, generatedAt, modelVersion: model.version };

async function listMarkdownFiles(directory, prefix = "") {
  const rows = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...(await listMarkdownFiles(absolutePath, relativePath)));
    else if (entry.name.endsWith(".md")) rows.push(relativePath);
  }
  return rows.sort((a, b) => a.localeCompare(b, "ja"));
}

async function mirrorRepositoryDocs() {
  await rm(vaultRepoDocsDir, { recursive: true, force: true });
  await mkdir(join(vaultRepoDocsDir, "docs"), { recursive: true });
  for (const file of [
    "README.md",
    "AGENTS.md",
    "AI_HANDOFF.md",
    "PROJECT_PROGRESS.md",
  ]) {
    await cp(join(projectDir, file), join(vaultRepoDocsDir, file));
  }
  await cp(join(projectDir, "docs"), join(vaultRepoDocsDir, "docs"), { recursive: true });
  const files = await listMarkdownFiles(vaultRepoDocsDir);
  const index = `# 80_リポジトリ文書（自動ミラー・手編集禁止）\n\nGitのREADME/docsをknowledge:update時に再コピーする。正本はリポジトリ側。\n\n${files
    .filter((file) => file !== "_INDEX.md")
    .map((file) => `- [[${file.replace(/\.md$/, "")}]]`)
    .join("\n")}\n`;
  await writeFile(join(vaultRepoDocsDir, "_INDEX.md"), index);
}

await Promise.all([
  writeFile(join(publicDir, "environment.html"), architectureHtml),
  writeFile(join(publicDir, "graph-stats.json"), `${JSON.stringify(graphStats, null, 2)}\n`),
  writeFile(join(docsDir, "AI_CONTEXT.md"), aiContext),
  writeFile(join(docsDir, "AI_KNOWLEDGE_SYSTEM.md"), systemDoc),
  writeFile(join(vaultAiDir, "00_AI_START_HERE.md"), aiStart),
  writeFile(join(vaultAiDir, "01_本番システム環境図.md"), runtimeDoc),
  writeFile(join(vaultAiDir, "02_業務データ_AI処理構成.md"), businessDoc),
  writeFile(join(vaultAiDir, "03_AI知識循環.md"), knowledgeDoc),
  writeFile(join(vaultAiDir, "04_情報源と更新ルール.md"), sourceDoc),
  writeFile(join(vaultAiDir, "05_AI作業チェックリスト.md"), checklistDoc),
  writeFile(join(vaultAiDir, "06_Graphify_Obsidianブリッジ.md"), bridgeDoc),
  writeFile(join(vaultAiDir, "runtime-system.canvas"), `${JSON.stringify(canvasForView("runtime"), null, 2)}\n`),
  writeFile(join(vaultAiDir, "business-ai-system.canvas"), `${JSON.stringify(canvasForView("business"), null, 2)}\n`),
  writeFile(join(vaultAiDir, "ai-knowledge-loop.canvas"), `${JSON.stringify(canvasForView("knowledge"), null, 2)}\n`),
  writeFile(join(vaultGraphifyDir, "_README.md"), `# 90_Graphify（自動生成・手編集禁止）\n\n- 生成元: LINE Reportの自作コードとSQL migration\n- 更新: \`npm run knowledge:update\`\n- 現在: ${stats.nodes}ノード / ${stats.edges}関係 / SQL ${stats.sqlFiles}ファイル\n- vendor/node_modules/秘密領域/生成物は除外。\n`),
]);

await mirrorRepositoryDocs();

const architectureHash = createHash("sha256").update(JSON.stringify(model)).digest("hex");
await writeFile(join(publicDir, "knowledge-system-manifest.json"), `${JSON.stringify({
  generatedAt,
  architectureHash,
  graph: stats,
  outputs: [
    "public/system-map/environment.html",
    "public/system-map/graph-stats.json",
    "docs/AI_CONTEXT.md",
    "docs/AI_KNOWLEDGE_SYSTEM.md",
    "Obsidian:70_AI作業環境/00_AI_START_HERE.md",
    "Obsidian:80_リポジトリ文書/_INDEX.md",
    "Obsidian:90_Graphify/graph.canvas"
  ],
}, null, 2)}\n`);

console.log(`[knowledge] generated LINE Report environment (${stats.nodes} nodes / ${stats.edges} relationships / ${stats.communities} communities / SQL ${stats.sqlFiles} files)`);
console.log(`[knowledge] Obsidian AI workspace: ${vaultAiDir}`);
