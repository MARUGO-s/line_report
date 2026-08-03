import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL("knowledge/supabase-ownership.json", root), "utf8"),
);
assert.equal(manifest.projectRef, "hocbnifuactbvmyjraxy");
assert.ok(Array.isArray(manifest.ownedFunctions) && manifest.ownedFunctions.length > 0);
assert.equal(new Set(manifest.ownedFunctions).size, manifest.ownedFunctions.length);

const functionEntries = await readdir(new URL("supabase/functions/", root), {
  withFileTypes: true,
});
const localFunctions = functionEntries
  .filter((entry) => entry.isDirectory() && entry.name !== "_shared")
  .map((entry) => entry.name)
  .sort();
const ownedFunctions = [...manifest.ownedFunctions].sort();

assert.deepEqual(
  ownedFunctions,
  localFunctions,
  "knowledge/supabase-ownership.json ownedFunctions must exactly match supabase/functions directories",
);
console.log(
  `[supabase-ownership] OK: ${ownedFunctions.length} owned functions in ${manifest.projectRef}`,
);
