import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
const includeGenerated = args.includes("--all");
const limitArg = args.find((arg) => arg.startsWith("--limit="));
const limit = Math.max(
  1,
  Math.min(30, Number(limitArg?.split("=")[1] ?? 8) || 8),
);
const query = args
  .filter((arg) => arg !== "--all" && !arg.startsWith("--limit="))
  .join(" ")
  .trim();

if (!query) {
  console.error(
    'Usage: npm run knowledge:search -- "<task or topic>" [--all] [--limit=8]',
  );
  process.exit(2);
}

const vaultAppDir =
  process.env.KNOWLEDGE_VAULT_APP_DIR ??
  "/Users/yoshito/Library/CloudStorage/Dropbox/web/アプリ知識/10_アプリ別/LINE Report";

async function collectMarkdown(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (!includeGenerated && entry.isDirectory() && entry.name === "90_Graphify") {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectMarkdown(path)));
    else if (entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

function normalize(value) {
  return value.normalize("NFKC").toLocaleLowerCase("ja-JP");
}

function termsFor(value) {
  const normalized = normalize(value);
  const terms = new Set([normalized]);
  const segmenter = new Intl.Segmenter("ja", { granularity: "word" });
  for (const segment of segmenter.segment(normalized)) {
    const term = segment.segment.trim();
    if (segment.isWordLike && term.length >= 2) terms.add(term);
  }
  for (const term of normalized.split(/[\s,./:;!?()[\]{}「」『』・、。]+/u)) {
    if (term.length >= 2) terms.add(term);
  }
  return [...terms];
}

function matchingExcerpt(content, terms) {
  const lines = content.split(/\r?\n/);
  const scored = lines
    .map((line, index) => ({
      line: line.trim(),
      index,
      score: terms.reduce(
        (score, term) => score + (normalize(line).includes(term) ? 1 : 0),
        0,
      ),
    }))
    .filter((item) => item.line && item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return scored
    .slice(0, 2)
    .map((item) => `L${item.index + 1}: ${item.line.slice(0, 180)}`)
    .join("\n    ");
}

const terms = termsFor(query);
let files;
try {
  files = await collectMarkdown(vaultAppDir);
} catch (error) {
  console.error(
    `[knowledge] could not read Obsidian app folder: ${vaultAppDir}`,
  );
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const results = [];

for (const path of files) {
  const content = await readFile(path, "utf8");
  const relativePath = relative(vaultAppDir, path);
  const normalizedPath = normalize(relativePath);
  const normalizedContent = normalize(content);
  let score = 0;
  for (const term of terms) {
    if (normalizedPath.includes(term)) score += 10;
    const headingMatches = [
      ...normalizedContent.matchAll(new RegExp(`^#{1,3} .*${escapeRegExp(term)}.*$`, "gmu")),
    ].length;
    score += headingMatches * 5;
    const bodyMatches = normalizedContent.split(term).length - 1;
    score += Math.min(bodyMatches, 8);
  }
  if (score > 0) {
    results.push({
      path: relativePath,
      score,
      excerpt: matchingExcerpt(content, terms),
    });
  }
}

results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, "ja"));

if (!results.length) {
  console.log(`[knowledge] no matching notes for: ${query}`);
  process.exit(0);
}

console.log(`[knowledge] ${results.length} matching note(s); top ${Math.min(limit, results.length)}`);
for (const result of results.slice(0, limit)) {
  console.log(`\n[${result.score}] ${result.path}`);
  if (result.excerpt) console.log(`    ${result.excerpt}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
