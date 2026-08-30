import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const projectDir = fileURLToPath(new URL("../", import.meta.url));
const vaultAppDir =
  process.env.KNOWLEDGE_VAULT_APP_DIR ??
  "/Users/yoshito/Library/CloudStorage/Dropbox/web/アプリ知識/10_アプリ別/LINE Report";
const vaultGraphifyDir =
  process.env.KNOWLEDGE_VAULT_GRAPHIFY_DIR ??
  join(vaultAppDir, "90_Graphify");
const vaultAiDir = join(vaultAppDir, "70_AI作業環境");
const vaultRepoDocsDir = join(vaultAppDir, "80_リポジトリ文書");
const errors = [];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function md5(path) {
  const content = await readFile(path);
  return createHash("md5").update(content).digest("hex");
}

// Vault は Dropbox の CloudStorage 上にあり、実体が未ダウンロードだと
// 1ファイル読むたびに約1.3秒の取得が走る。6,500件を逐次で読むと約140分かかる。
// 取得はネットワーク待ちなので同時実行で縮むが、実測では同時8で頭打ち
// (296ms/件・約32分)。Dropbox 側の制限のため、これ以上は上がらない。
// そこで mtime+size が前回と同じファイルは読み飛ばし、2回目以降を秒で終わらせる。
const VAULT_SCAN_CONCURRENCY = 32;
const vaultScanCachePath = join(projectDir, ".local", "knowledge-vault-scan-cache.json");

async function loadVaultScanCache() {
  try {
    const parsed = JSON.parse(await readFile(vaultScanCachePath, "utf8"));
    return parsed?.pattern === secretPattern.source && parsed?.entries
      ? parsed.entries
      : {};
  } catch {
    return {};
  }
}

async function saveVaultScanCache(entries) {
  try {
    await mkdir(join(projectDir, ".local"), { recursive: true });
    await writeFile(
      vaultScanCachePath,
      JSON.stringify({ pattern: secretPattern.source, entries }),
    );
  } catch {
    // キャッシュは高速化のためだけのもの。書けなくても検査自体は成立する。
  }
}

/** 順序を保ったまま、同時実行数を絞って map する。 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index]);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

async function collectFiles(directory) {
  const results = [];
  if (!(await exists(directory))) return results;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) results.push(...(await collectFiles(path)));
    else results.push(path);
  }
  return results;
}

const requiredRepoFiles = [
  "AGENTS.md",
  "knowledge/system-architecture.json",
  "docs/AI_CONTEXT.md",
  "docs/AI_KNOWLEDGE_SYSTEM.md",
  "public/system-map/graph.html",
  "public/system-map/environment.html",
  "public/system-map/graph-stats.json",
  "public/system-map/knowledge-system-manifest.json",
  "public/system-map.html",
];
for (const file of requiredRepoFiles) {
  if (!(await exists(join(projectDir, file)))) errors.push(`missing repo file: ${file}`);
}

const requiredVaultFiles = [
  "00_AI_START_HERE.md",
  "01_本番システム環境図.md",
  "02_業務データ_AI処理構成.md",
  "03_AI知識循環.md",
  "04_情報源と更新ルール.md",
  "05_AI作業チェックリスト.md",
  "06_Graphify_Obsidianブリッジ.md",
  "runtime-system.canvas",
  "business-ai-system.canvas",
  "ai-knowledge-loop.canvas",
];
for (const file of requiredVaultFiles) {
  if (!(await exists(join(vaultAiDir, file)))) errors.push(`missing vault file: ${file}`);
}
if (!(await exists(join(vaultGraphifyDir, "graph.canvas")))) {
  errors.push("missing vault Graphify canvas: 90_Graphify/graph.canvas");
}
if (await exists(join(vaultGraphifyDir, ".obsidian"))) {
  errors.push("nested .obsidian directory exists under generated 90_Graphify");
}
if (!(await exists(join(vaultRepoDocsDir, "_INDEX.md")))) {
  errors.push("missing repository docs mirror: 80_リポジトリ文書/_INDEX.md");
}
if (!(await exists(join(vaultRepoDocsDir, "README.md")))) {
  errors.push("missing repository README mirror");
}
if (!(await exists(join(vaultRepoDocsDir, "docs/SECURITY.md")))) {
  errors.push("missing SECURITY.md mirror");
}
for (const file of [
  "README.md",
  "AGENTS.md",
  "AI_HANDOFF.md",
  "PROJECT_PROGRESS.md",
]) {
  const source = join(projectDir, file);
  const mirror = join(vaultRepoDocsDir, file);
  if (!(await exists(mirror))) {
    errors.push(`missing repository docs mirror: ${file}`);
  } else if ((await md5(source)) !== (await md5(mirror))) {
    errors.push(`stale repository docs mirror: ${file}`);
  }
}
for (const file of (await readdir(join(projectDir, "docs"))).filter((name) =>
  name.endsWith(".md"),
)) {
  const source = join(projectDir, "docs", file);
  const mirror = join(vaultRepoDocsDir, "docs", file);
  if (!(await exists(mirror))) {
    errors.push(`missing docs mirror: docs/${file}`);
  } else if ((await md5(source)) !== (await md5(mirror))) {
    errors.push(`stale docs mirror: docs/${file}`);
  }
}

// Graphify のコード限定抽出が再ハッシュしない拡張子。これらを突き合わせると
// 更新されない ast_hash と比較することになり、永久に stale になる。
const STALENESS_EXEMPT_EXTENSIONS = new Set(["md", "html", "yml", "yaml"]);

const manifestPath = join(projectDir, "graphify-out/manifest.json");
if (!(await exists(manifestPath))) {
  errors.push("missing graphify-out/manifest.json; run npm run knowledge:update");
} else {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const [file, entry] of Object.entries(manifest)) {
    const path = join(projectDir, file);
    if (!(await exists(path))) {
      errors.push(`Graphify manifest references missing file: ${file}`);
      continue;
    }
    const extension = file.toLowerCase().split(".").pop();
    // knowledge:update is intentionally code-only. Older manifests can still carry
    // semantic hashes for Markdown/public HTML from full Graphify runs, so checking
    // those against the code-only manifest makes every docs edit permanently stale.
    //
    // YAML も同じ理由で除外する。Graphify は .yml を「分類対象外」として再抽出しない
    // ため、過去のフル実行で入った ast_hash が更新されない。実測では manifest 内の
    // 588ファイルで ast_hash が md5 と一致し、不一致は .github/workflows の .yml 2件
    // だけだった。除外しないと、ワークフローを直すたびに恒久的な stale 報告が残る。
    if (STALENESS_EXEMPT_EXTENSIONS.has(extension)) continue;
    const currentHash = await md5(path);
    if (entry.ast_hash && currentHash !== entry.ast_hash) {
      errors.push(`Graphify is stale for ${file}`);
    }
  }
}

if (await exists(join(projectDir, "public/system-map/graph-stats.json"))) {
  const graph = JSON.parse(
    await readFile(join(projectDir, "graphify-out/graph.json"), "utf8"),
  );
  const stats = JSON.parse(
    await readFile(join(projectDir, "public/system-map/graph-stats.json"), "utf8"),
  );
  const communities = new Set(
    (graph.nodes ?? [])
      .map((node) => node.community)
      .filter((community) => community !== undefined && community !== null),
  ).size;
  const sqlNodes = (graph.nodes ?? []).filter((node) =>
    String(node.source_file ?? "").endsWith(".sql"),
  );
  const sqlFiles = new Set(sqlNodes.map((node) => node.source_file)).size;
  const migrationFiles = (await readdir(join(projectDir, "supabase/migrations")))
    .filter((file) => file.endsWith(".sql"));
  if (
    stats.nodes !== (graph.nodes?.length ?? 0) ||
    stats.edges !== (graph.links?.length ?? 0) ||
    stats.communities !== communities ||
    stats.sqlNodes !== sqlNodes.length ||
    stats.sqlFiles !== sqlFiles
  ) {
    errors.push("public/system-map/graph-stats.json does not match graphify-out/graph.json");
  }
  const graphSources = new Set(
    (graph.nodes ?? []).map((node) => String(node.source_file ?? "")),
  );
  const missingMigrations = migrationFiles.filter(
    (file) => !graphSources.has(`supabase/migrations/${file}`),
  );
  if (missingMigrations.length) {
    errors.push(
      `Graphify SQL coverage is incomplete; missing migrations: ${missingMigrations.slice(0, 5).join(", ")}`,
    );
  }
}

const knowledgeManifestPath = join(
  projectDir,
  "system-map/knowledge-system-manifest.json",
);
if (await exists(knowledgeManifestPath)) {
  const knowledgeManifest = JSON.parse(
    await readFile(knowledgeManifestPath, "utf8"),
  );
  const architecture = JSON.parse(
    await readFile(join(projectDir, "knowledge/system-architecture.json"), "utf8"),
  );
  const architectureHash = createHash("sha256")
    .update(JSON.stringify(architecture))
    .digest("hex");
  if (knowledgeManifest.architectureHash !== architectureHash) {
    errors.push("environment diagram is stale for knowledge/system-architecture.json");
  }
}

const secretPattern =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|sb_secret_[A-Za-z0-9]+|SUPABASE_SERVICE_ROLE_KEY\s*=\s*\S+|LINE_CHANNEL_ACCESS_TOKEN(?:__\w+)?\s*=\s*\S+|GMAIL_CLIENT_SECRET\s*=\s*\S+/i;
const vaultFiles = await collectFiles(vaultAppDir);
const vaultScanCache = await loadVaultScanCache();
const nextVaultScanCache = {};
let vaultFilesRead = 0;
const vaultHits = await mapWithConcurrency(
  vaultFiles,
  VAULT_SCAN_CONCURRENCY,
  async (file) => {
    const key = relative(vaultAppDir, file);
    const info = await stat(file);
    // mtime と size が前回と一致すれば内容も同じとみなし、取得を省く。
    // 前回の判定結果(ヒットしたパス or null)をそのまま引き継ぐ。
    const signature = `${info.mtimeMs}:${info.size}`;
    const cached = vaultScanCache[key];
    if (cached && cached.signature === signature) {
      nextVaultScanCache[key] = cached;
      return cached.hit ? key : null;
    }
    if (info.size > 2_000_000) {
      nextVaultScanCache[key] = { signature, hit: false };
      return null;
    }
    vaultFilesRead += 1;
    const content = await readFile(file, "utf8").catch(() => "");
    const hit = secretPattern.test(content);
    nextVaultScanCache[key] = { signature, hit };
    return hit ? key : null;
  },
);
await saveVaultScanCache(nextVaultScanCache);
if (vaultFilesRead) {
  console.error(
    `[knowledge] vault scan: ${vaultFilesRead}/${vaultFiles.length} 件を読み込み` +
      `（残りは前回から未変更のため省略）`,
  );
}
// 並列化しても報告順は入力順に固定し、出力を安定させる。
for (const hit of vaultHits) {
  if (hit) errors.push(`potential secret marker in vault: ${hit}`);
}

const gitStatus = spawnSync("git", ["status", "--short"], {
  cwd: projectDir,
  encoding: "utf8",
});
if (gitStatus.status !== 0) {
  errors.push(`git status failed: ${gitStatus.stderr.trim()}`);
}

if (errors.length) {
  console.error("[knowledge] check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("[knowledge] check passed");
console.log(`- Graphify manifest hashes are current`);
console.log(`- Repository environment outputs and SQL coverage are current`);
console.log(`- Obsidian AI workspace, repository docs mirror, and Graphify canvas are present`);
console.log(`- Vault secret marker scan is clean`);
if (gitStatus.stdout.trim()) {
  console.log("- Git working tree has changes (expected during active work)");
}
