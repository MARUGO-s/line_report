#!/usr/bin/env node
// 保存済みのPOS電子ジャーナル原本(.lzh)を、まだ取り込まれていない分だけ本番へ送る。
//
// レジを入れ替えると同じ店舗でもファイル名先頭の店舗コードが変わる。
// (例: Bistro CAVACAVA は 1020 -> 1015 を 2026-01-29 に切り替えている)
// どのコードがどの店舗かは DB の pos_journal_store_codes が持つので、
// ここでは推測せず、その表と突き合わせてから送る。
//
// 使い方:
//   node scripts/upload-pos-journal-archive.mjs <ディレクトリ...> --store <キー> [--apply]
//   既定は dry-run。--apply を付けたときだけ実際に送信する。

import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const PROJECT_REF = "hocbnifuactbvmyjraxy";
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const ADMIN_API_URL = `${SUPABASE_URL}/functions/v1/admin-api`;
const CLI_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 145_000;
// admin-api 側の上限に合わせる (POS_JOURNAL_UPLOAD_MAX_FILES / _MAX_BYTES)。
const UPLOAD_MAX_FILES = 62;
const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
const START_AT = Date.now();

function progress(message) {
  const elapsed = Math.round((Date.now() - START_AT) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  process.stderr.write(`[${mm}:${ss}] ${message}\n`);
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const storeIndex = args.indexOf("--store");
const storeKey = storeIndex >= 0 ? args[storeIndex + 1] : "";
const directories = args.filter((arg, index) =>
  !arg.startsWith("--") && index !== storeIndex + 1
);
if (!storeKey || !directories.length) {
  console.error(
    "使い方: node scripts/upload-pos-journal-archive.mjs <ディレクトリ...> --store <キー> [--apply]",
  );
  process.exit(2);
}

// --- 資格情報 ---------------------------------------------------------------
// `npx supabase` は CLI 未導入だと確認プロンプトで止まる。stdin を塞いだまま
// 呼ぶと問いが見えず答えられず無言で固まるため、解決済みバイナリを優先する。
function resolveSupabaseBinary() {
  for (const candidate of ["supabase", "./node_modules/.bin/supabase"]) {
    try {
      execFileSync(candidate, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      });
      return candidate;
    } catch {
      // 次の候補へ
    }
  }
  return null;
}

function loadServiceRoleKey() {
  progress("Supabase CLI から service_role キーを取得しています...");
  const cliArgs = [
    "projects",
    "api-keys",
    "--project-ref",
    PROJECT_REF,
    "--output",
    "json",
    "--reveal",
  ];
  const binary = resolveSupabaseBinary();
  const command = binary ?? "npx";
  const commandArgs = binary ? cliArgs : ["supabase", ...cliArgs];
  let raw;
  try {
    raw = execFileSync(command, commandArgs, {
      encoding: "utf8",
      stdio: binary ? ["ignore", "pipe", "pipe"] : ["inherit", "pipe", "inherit"],
      timeout: CLI_TIMEOUT_MS,
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || "").trim()
      .split("\n").slice(0, 3).join(" / ");
    throw new Error(
      "Supabase CLI を実行できませんでした。`npx supabase --version` で導入し、" +
        `\`npx supabase login\` でログインしてから再実行してください。\n  ${detail}`,
    );
  }
  const parsed = JSON.parse(raw);
  const rows = Array.isArray(parsed) ? parsed : parsed?.api_keys || parsed?.keys || [];
  const key =
    rows.find((row) => row?.name === "default" && row?.type === "secret")?.api_key ||
    rows.find((row) => row?.name === "service_role" && row?.type === "legacy")?.api_key;
  if (
    typeof key !== "string" ||
    !(/^sb_secret_[A-Za-z0-9_-]+$/.test(key) ||
      /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key))
  ) {
    throw new Error("server-only な Supabase キーを取得できませんでした。");
  }
  return key;
}

async function fetchRest(serviceRoleKey, table, params) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const headers = { apikey: serviceRoleKey };
  if (serviceRoleKey.startsWith("eyJ")) headers.authorization = `Bearer ${serviceRoleKey}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${table} の参照に失敗しました (HTTP ${response.status})`);
  return response.json();
}

// --- 対象の収集 -------------------------------------------------------------
async function collectLzhFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectLzhFiles(path)));
      continue;
    }
    // macOS の AppleDouble(._*) は中身が原本ではないので必ず除く。
    if (!entry.name.toLowerCase().endsWith(".lzh")) continue;
    if (entry.name.startsWith("._")) continue;
    files.push(path);
  }
  return files;
}

/** ファイル名 先頭4桁=店舗コード, 続く8桁=営業日 (YYYYMMDD)。 */
function describeFile(path) {
  const name = basename(path);
  const code = name.slice(0, 4);
  const day = name.slice(4, 12);
  if (!/^\d{4}$/.test(code) || !/^\d{8}$/.test(day)) return null;
  return {
    path,
    name,
    code,
    businessDate: `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`,
  };
}

const serviceRoleKey = loadServiceRoleKey();

const codeRows = await fetchRest(serviceRoleKey, "pos_journal_store_codes", {
  select: "store_code,store_partition_key,store_name",
});
const allowedCodes = new Set(
  codeRows
    .filter((row) => String(row.store_partition_key).toLowerCase() === storeKey.toLowerCase())
    .map((row) => String(row.store_code)),
);
if (!allowedCodes.size) {
  throw new Error(`${storeKey} に対応する店舗コードが pos_journal_store_codes にありません。`);
}
progress(`${storeKey} の店舗コード: ${[...allowedCodes].sort().join(", ")}`);

const existingRows = await fetchRest(serviceRoleKey, "pos_journal_files", {
  select: "business_date",
  store_partition_key: `eq.${storeKey}`,
  storage_deleted_at: "is.null",
});
const existingDates = new Set(existingRows.map((row) => String(row.business_date)));
progress(`取り込み済み: ${existingDates.size} 営業日`);

const candidates = [];
const rejected = { foreignCode: [], unparsable: [], alreadyStored: [], tooLarge: [] };
for (const directory of directories) {
  for (const path of await collectLzhFiles(resolve(directory))) {
    const info = describeFile(path);
    if (!info) {
      rejected.unparsable.push(basename(path));
      continue;
    }
    if (!allowedCodes.has(info.code)) {
      rejected.foreignCode.push(`${info.name} (コード ${info.code})`);
      continue;
    }
    // 同一店舗・同一営業日は一意制約があるので、既存日は送らない。
    if (existingDates.has(info.businessDate)) {
      rejected.alreadyStored.push(info.businessDate);
      continue;
    }
    const size = (await stat(path)).size;
    if (size > UPLOAD_MAX_BYTES) {
      rejected.tooLarge.push(`${info.name} (${size} bytes)`);
      continue;
    }
    candidates.push({ ...info, size });
  }
}
candidates.sort((a, b) => a.name.localeCompare(b.name));

// 同じ営業日が複数ファイルある場合、一意制約で1件しか残らない。
// どれを残すかを運任せにしないよう、ファイル名順の最後(=遅い時刻)を採用する。
const perDate = new Map();
for (const file of candidates) perDate.set(file.businessDate, file);
const targets = [...perDate.values()];
const supersededSameDay = candidates.length - targets.length;

const summary = {
  store_key: storeKey,
  directories: directories.map((d) => resolve(d)),
  allowed_codes: [...allowedCodes].sort(),
  found: candidates.length + rejected.foreignCode.length + rejected.alreadyStored.length,
  to_upload: targets.length,
  bytes: targets.reduce((sum, file) => sum + file.size, 0),
  business_dates: targets.length
    ? { from: targets[0].businessDate, to: targets[targets.length - 1].businessDate }
    : null,
  skipped: {
    別店舗コード: rejected.foreignCode.length,
    取り込み済み: new Set(rejected.alreadyStored).size,
    同一営業日の重複: supersededSameDay,
    サイズ超過: rejected.tooLarge.length,
    ファイル名が想定外: rejected.unparsable.length,
  },
};

if (rejected.foreignCode.length) {
  progress(`別店舗コードのため除外: ${rejected.foreignCode.slice(0, 3).join(", ")}` +
    (rejected.foreignCode.length > 3 ? ` ほか${rejected.foreignCode.length - 3}件` : ""));
}

if (!targets.length) {
  console.log(JSON.stringify({ ok: true, mode: apply ? "apply" : "dry-run", ...summary }, null, 2));
  process.exit(0);
}
if (targets.length > UPLOAD_MAX_FILES) {
  throw new Error(
    `1回で送れるのは ${UPLOAD_MAX_FILES} 件までです (対象 ${targets.length} 件)。` +
      "ディレクトリを分けて実行してください。",
  );
}

if (!apply) {
  progress("dry-run のため送信しません。適用するには --apply を付けてください。");
  console.log(JSON.stringify({
    ok: true,
    mode: "dry-run",
    ...summary,
    files: targets.map((file) => ({ name: file.name, business_date: file.businessDate })),
  }, null, 2));
  process.exit(0);
}

progress(`${targets.length} 件を送信します...`);
const form = new FormData();
form.set("store_key", storeKey);
for (const file of targets) {
  form.append("files", new Blob([await readFile(file.path)]), file.name);
}
const response = await fetch(`${ADMIN_API_URL}/pos-journals/upload`, {
  method: "POST",
  headers: { apikey: serviceRoleKey, "x-internal-key": serviceRoleKey },
  body: form,
  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
});
let payload;
try {
  payload = await response.json();
} catch {
  throw new Error(`アップロードが非JSONで失敗しました (HTTP ${response.status})`);
}
if (!response.ok) {
  throw new Error(`アップロード失敗 (HTTP ${response.status}): ${payload?.error ?? "不明"}`);
}
progress("送信完了。");
console.log(JSON.stringify({ ok: true, mode: "apply", ...summary, result: payload }, null, 2));
