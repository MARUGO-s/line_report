import { access, readFile, readdir } from "node:fs/promises";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists("graphify-out/graph.json"))) {
  console.error("[graphify] graph.json is missing");
  process.exit(1);
}

const graph = JSON.parse(await readFile("graphify-out/graph.json", "utf8"));
const sources = new Set(
  (graph.nodes ?? []).map((node) => String(node.source_file ?? "")),
);
const migrations = (await readdir("supabase/migrations"))
  .filter((file) => file.endsWith(".sql"))
  .map((file) => `supabase/migrations/${file}`);
const missing = migrations.filter((file) => !sources.has(file));

if (missing.length) {
  console.error(
    `[graphify] SQL coverage incomplete: ${missing.length}/${migrations.length} migrations are missing`,
  );
  for (const file of missing.slice(0, 8)) console.error(`- ${file}`);
  process.exit(1);
}

console.log(
  `[graphify] SQL coverage OK: ${migrations.length}/${migrations.length} migrations`,
);
