import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adminApi = await readFile(
  new URL("../supabase/functions/admin-api/index.ts", import.meta.url),
  "utf8",
);
const html = await readFile(
  new URL("../public/jnm/jnl2txt.html", import.meta.url),
  "utf8",
);
const indexHtml = await readFile(
  new URL("../public/jnm/index.html", import.meta.url),
  "utf8",
);

function sectionBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must exist`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} must exist after ${startMarker}`);
  return source.slice(start, end);
}

const normalize = sectionBetween(
  adminApi,
  "function normalizeStoreOpsWineMl(",
  "async function fetchStoreOperationProfile(",
);
const save = sectionBetween(
  adminApi,
  "async function saveStoreOperationProfile(",
  "// ===== Journal Report 店舗ナレッジ",
);

test("store ops wineMl keeps bottle fixed at 750 and clamps glass/pairing", () => {
  assert.match(normalize, /bottleMl:\s*750/);
  assert.match(normalize, /glassMl:\s*clampMl/);
  assert.match(normalize, /pairingMl:\s*clampMl/);
  assert.match(normalize, /wineMl:\s*normalizeStoreOpsWineMl/);
});

test("store ops save preserves wineMl when key omitted", () => {
  assert.match(save, /omitWineMl/);
  assert.match(save, /profile\.wineMl = normalizeStoreOpsWineMl/);
});

test("Journal Report UI and AI analysis wire wine ml settings", () => {
  assert.match(html, /id="opsWineGlassMl"/);
  assert.match(html, /id="opsWineBottleMl"/);
  assert.match(html, /id="opsWinePairingMl"/);
  assert.match(html, /ワイン提供量の換算/);
  assert.match(html, /function computeWineMlVolumeAnalysis/);
  assert.match(html, /wineVolumeAnalysis/);
  assert.match(html, /wineMlProducts/);
  assert.match(html, /分析アイテム・ワイン提供量\(ml\)/);
  assert.match(html, /ワイン提供量\(ml\)・必須/);
  assert.match(html, /レポート構成と必須フォーマット/);
  assert.match(html, /ワイン提供量（店舗換算ml）/);
  assert.match(html, /keepWineMl/);
  assert.equal(html, indexHtml, "jnl2txt.html and index.html must stay in sync");
});

test("standard AI analyze prompt requires wine ml chapter", async () => {
  const aiAnalyze = await readFile(
    new URL("../supabase/functions/ai-analyze/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(aiAnalyze, /ワイン提供量\(ml\)・必須/);
  assert.match(aiAnalyze, /salesData\.wineVolumeAnalysis/);
  assert.match(aiAnalyze, /標準分析の必須節/);
});
