import { createHash } from "node:crypto";
import {
  access,
  readFile,
  readdir,
  stat,
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
    if (extension === "md" || extension === "html") continue;
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
for (const file of await collectFiles(vaultAppDir)) {
  const info = await stat(file);
  if (info.size > 2_000_000) continue;
  const content = await readFile(file, "utf8").catch(() => "");
  if (secretPattern.test(content)) {
    errors.push(`potential secret marker in vault: ${relative(vaultAppDir, file)}`);
  }
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
