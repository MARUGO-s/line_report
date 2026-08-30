#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const CLI_TIMEOUT_MS = 60_000;
const START_AT = Date.now();

/**
 * 進捗は stderr に出す。stdout は最終JSONだけに保ち、
 * `node ... | jq` のようなパイプ利用を壊さない。
 */
function progress(message) {
  const elapsed = Math.round((Date.now() - START_AT) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  process.stderr.write(`[${mm}:${ss}] ${message}\n`);
}

const PROJECT_REF = "hocbnifuactbvmyjraxy";
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const ADMIN_API_URL = `${SUPABASE_URL}/functions/v1/admin-api`;
const PARSER_VERSION = "2026-08-30-v22";
const BATCH_LIMIT = 20;
const REQUEST_TIMEOUT_MS = 145_000;
const MAX_BATCHES = 80;
const MAX_BATCH_ATTEMPTS = 3;

const TARGETS = Object.freeze([
  Object.freeze({ storeKey: "marugos", files: 260, months: 9, gross: 50_862_748 }),
  Object.freeze({ storeKey: "bistrocavacava", files: 170, months: 9, gross: 10_548_410 }),
]);

const allowedArgs = new Set(["--apply", "--dry-run"]);
for (const arg of process.argv.slice(2)) {
  if (!allowedArgs.has(arg)) {
    throw new Error(`Unknown argument: ${arg}`);
  }
}
const apply = process.argv.includes("--apply");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SUPABASE_CLI_ARGS = Object.freeze([
  "projects",
  "api-keys",
  "--project-ref",
  PROJECT_REF,
  "--output",
  "json",
  "--reveal",
]);

/**
 * 解決済みの supabase バイナリを探す。
 *
 * `npx supabase` は CLI 未導入だと確認プロンプトを出して応答を待つ。旧実装は
 * stdin を ignore、stdout/stderr を pipe にしていたため、その問いが画面に出ない
 * まま永久に止まっていた（--no-install を付けても止まることを実測で確認済み）。
 * まず PATH と node_modules を探し、npx へ落ちる前に確実な経路を使う。
 */
function resolveSupabaseBinary() {
  const candidates = ["supabase", new URL("../node_modules/.bin/supabase", import.meta.url).pathname];
  for (const candidate of candidates) {
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
  const binary = resolveSupabaseBinary();
  // 解決できたバイナリは非対話で呼ぶ。npx へ落ちる場合だけ、プロンプトが
  // 見えて答えられるように stdin と stderr を端末へつなぐ。
  const command = binary ?? "npx";
  const args = binary ? SUPABASE_CLI_ARGS : ["supabase", ...SUPABASE_CLI_ARGS];
  if (!binary) {
    progress(
      "supabase バイナリが見つかりません。npx 経由で起動します" +
        "（未導入の場合は npx が導入の可否を尋ねます。応答してください）",
    );
  }
  let raw;
  try {
    raw = execFileSync(command, args, {
      encoding: "utf8",
      // stdout は JSON を取るため必ず pipe。npx 経路では stdin/stderr を端末に渡す。
      stdio: binary ? ["ignore", "pipe", "pipe"] : ["inherit", "pipe", "inherit"],
      timeout: CLI_TIMEOUT_MS,
    });
  } catch (error) {
    const timedOut = error?.killed === true || error?.signal != null;
    const detail = String(error?.stderr || error?.message || "").trim().split("\n").slice(0, 3).join(" / ");
    throw new Error(
      (timedOut
        ? `Supabase CLI が ${CLI_TIMEOUT_MS / 1000} 秒で応答しませんでした。`
        : "Supabase CLI の実行に失敗しました。") +
        "\n  `npx supabase --version` で CLI を導入し、`npx supabase login` でログインしてから再実行してください。" +
        (detail ? `\n  詳細: ${detail}` : ""),
    );
  }
  let rows;
  try {
    const parsed = JSON.parse(raw);
    rows = Array.isArray(parsed) ? parsed : parsed?.api_keys || parsed?.keys || [];
  } catch {
    throw new Error("Supabase API key response was not valid JSON.");
  }
  const key =
    rows.find((row) => row?.name === "default" && row?.type === "secret")?.api_key ||
    rows.find((row) => row?.name === "service_role" && row?.type === "legacy")?.api_key;
  if (
    typeof key !== "string" ||
    !(
      /^sb_secret_[A-Za-z0-9_-]+$/.test(key) ||
      /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)
    )
  ) {
    throw new Error("A server-only Supabase secret/service_role key was not available.");
  }
  return key;
}

async function callAdmin(serviceRoleKey, path, body) {
  const response = await fetch(`${ADMIN_API_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: serviceRoleKey,
      "x-internal-key": serviceRoleKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${path} returned non-JSON HTTP ${response.status}.`);
  }
  if (!response.ok) {
    throw new Error(`${path} failed with HTTP ${response.status}: ${payload?.error || "unknown error"}`);
  }
  return payload;
}

function validateReparseBatch(payload) {
  if (payload?.ok !== true || Number(payload?.failed_count || 0) !== 0) {
    const firstError = Array.isArray(payload?.failures) ? payload.failures[0]?.error : "";
    throw new Error(`Reparse batch failed: ${firstError || "unknown row failure"}`);
  }
  const reparsed = Array.isArray(payload.reparsed) ? payload.reparsed : [];
  for (const row of reparsed) {
    if (
      row?.detail_complete !== true ||
      Number(row?.receipt_total) !== Number(row?.gross_sales)
    ) {
      throw new Error(`Reparse reconciliation failed for journal id ${row?.id ?? "unknown"}.`);
    }
  }
}

async function loadReparseBatch(serviceRoleKey, body) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt += 1) {
    try {
      const payload = await callAdmin(serviceRoleKey, "/pos-journals/reparse", body);
      validateReparseBatch(payload);
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_BATCH_ATTEMPTS) {
        progress(`  batch 失敗 (${attempt}/${MAX_BATCH_ATTEMPTS}) — 再試行します: ${error?.message || error}`);
        await sleep(attempt * 1500);
      }
    }
  }
  throw lastError;
}

async function reparseStore(serviceRoleKey, target, dryRun) {
  let afterId = 0;
  const seenIds = new Set();
  const pendingMonths = new Set();
  let gross = 0;
  let reparsedCount = 0;
  let skippedCount = 0;

  const label = dryRun ? "dry-run" : "apply";
  progress(`${target.storeKey}: 再解析 ${label} を開始 (全 ${target.files} 件 / ${BATCH_LIMIT} 件ずつ)`);
  for (let batch = 1; batch <= MAX_BATCHES; batch += 1) {
    const payload = await loadReparseBatch(serviceRoleKey, {
      store_key: target.storeKey,
      after_id: afterId,
      limit: BATCH_LIMIT,
      force: dryRun,
      dry_run: dryRun,
    });
    const rows = [
      ...(Array.isArray(payload.reparsed) ? payload.reparsed : []),
      ...(Array.isArray(payload.skipped) ? payload.skipped : []),
    ];
    for (const row of rows) {
      const id = Number(row?.id);
      if (Number.isSafeInteger(id) && id > 0) seenIds.add(id);
    }
    for (const row of Array.isArray(payload.reparsed) ? payload.reparsed : []) {
      gross += Number(row.gross_sales) || 0;
    }
    reparsedCount += Number(payload.reparsed_count) || 0;
    skippedCount += Number(payload.skipped_count) || 0;
    for (const month of Array.isArray(payload.pending_reparse_months)
      ? payload.pending_reparse_months
      : []) pendingMonths.add(String(month));
    for (const month of Array.isArray(payload.safe_rebuild_months)
      ? payload.safe_rebuild_months
      : []) pendingMonths.delete(String(month));

    progress(
      `${target.storeKey}: batch ${batch} 完了 — ${seenIds.size}/${target.files} 件` +
        ` (再解析 ${reparsedCount} / スキップ ${skippedCount})`,
    );
    if (payload.has_more !== true) break;
    const nextAfterId = Number(payload.next_after_id);
    if (!Number.isSafeInteger(nextAfterId) || nextAfterId <= afterId) {
      throw new Error(`Reparse cursor did not advance for ${target.storeKey}.`);
    }
    afterId = nextAfterId;
    if (batch === MAX_BATCHES) {
      throw new Error(`Reparse exceeded ${MAX_BATCHES} batches for ${target.storeKey}.`);
    }
  }

  if (seenIds.size !== target.files) {
    throw new Error(`${target.storeKey}: expected ${target.files} files, saw ${seenIds.size}.`);
  }
  if (dryRun && gross !== target.gross) {
    throw new Error(`${target.storeKey}: expected gross ${target.gross}, dry-run produced ${gross}.`);
  }
  if (!dryRun && pendingMonths.size) {
    throw new Error(`${target.storeKey}: pending reparse months remain: ${[...pendingMonths].join(", ")}`);
  }
  return {
    store_key: target.storeKey,
    files: seenIds.size,
    reparsed: reparsedCount,
    skipped: skippedCount,
    ...(dryRun ? { gross } : {}),
  };
}

function validateCoverage(target, payload) {
  const coverage = payload?.detail_coverage || {};
  if (
    payload?.ok !== true ||
    Number(payload?.source_months_found) !== target.months ||
    Number(coverage.scanned_days) !== target.files ||
    coverage.status !== "complete" ||
    Number(coverage.detail_incomplete_days) !== 0 ||
    Number(coverage.gross_mismatch_days) !== 0 ||
    Number(coverage.item_mismatch_days) !== 0 ||
    Number(coverage.excluded_gross_sales) !== 0
  ) {
    throw new Error(`${target.storeKey}: product detail coverage is not complete.`);
  }
}

async function rebuildStore(serviceRoleKey, target, dryRun) {
  progress(`${target.storeKey}: 商品インデックス再構築 ${dryRun ? "dry-run" : "apply"} を実行中...`);
  const payload = await callAdmin(serviceRoleKey, "/pos-journals/product-index/rebuild", {
    store_key: target.storeKey,
    force_full: true,
    dry_run: dryRun,
  });
  validateCoverage(target, payload);
  return {
    store_key: target.storeKey,
    months: Number(payload.rebuilt_months),
    scanned_days: Number(payload.detail_coverage.scanned_days),
    status: payload.detail_coverage.status,
  };
}

async function fetchRest(serviceRoleKey, table, params) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const headers = { apikey: serviceRoleKey };
  if (serviceRoleKey.startsWith("eyJ")) {
    headers.authorization = `Bearer ${serviceRoleKey}`;
  }
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${table} verification failed with HTTP ${response.status}.`);
  return response.json();
}

async function verifyProduction(serviceRoleKey) {
  progress("本番データの最終検証を実行中...");
  const storesFilter = `in.(${TARGETS.map((target) => target.storeKey).join(",")})`;
  const files = await fetchRest(serviceRoleKey, "pos_journal_files", {
    select:
      "id,store_partition_key,year_month,gross_sales,receipts_count,parser_version:parsed_data->>parser_version",
    storage_deleted_at: "is.null",
    store_partition_key: storesFilter,
    order: "store_partition_key.asc,year_month.asc,id.asc",
  });
  const coverage = await fetchRest(serviceRoleKey, "journal_product_detail_coverage", {
    select:
      "store_partition_key,year_month,status,scanned_days,gross_mismatch_days,item_mismatch_days,item_mismatch_receipts,excluded_gross_sales",
    store_partition_key: storesFilter,
    order: "store_partition_key.asc,year_month.asc",
  });
  const dirty = await fetchRest(serviceRoleKey, "journal_product_index_dirty_months", {
    select: "store_partition_key,year_month",
    store_partition_key: storesFilter,
  });
  const adjustments = await fetchRest(serviceRoleKey, "journal_product_monthly_index", {
    select: "id",
    store_partition_key: storesFilter,
    product_code: "eq.__journal_adjustment__",
  });

  const summary = [];
  for (const target of TARGETS) {
    const storeFiles = files.filter((row) => row.store_partition_key === target.storeKey);
    const storeCoverage = coverage.filter((row) => row.store_partition_key === target.storeKey);
    const gross = storeFiles.reduce((sum, row) => sum + (Number(row.gross_sales) || 0), 0);
    const parserFiles = storeFiles.filter((row) => row.parser_version === PARSER_VERSION).length;
    const coverageScannedDays = storeCoverage.reduce(
      (sum, row) => sum + (Number(row.scanned_days) || 0),
      0,
    );
    const completeCoverage = storeCoverage.every((row) =>
      row.status === "complete" &&
      Number(row.gross_mismatch_days) === 0 &&
      Number(row.item_mismatch_days) === 0 &&
      Number(row.item_mismatch_receipts) === 0 &&
      Number(row.excluded_gross_sales) === 0
    );
    if (
      storeFiles.length !== target.files ||
      parserFiles !== target.files ||
      gross !== target.gross ||
      storeCoverage.length !== target.months ||
      coverageScannedDays !== target.files ||
      !completeCoverage
    ) {
      throw new Error(`${target.storeKey}: final database verification failed.`);
    }
    summary.push({
      store_key: target.storeKey,
      files: storeFiles.length,
      parser_v22: parserFiles,
      months_complete: storeCoverage.length,
      coverage_scanned_days: coverageScannedDays,
      gross,
    });
  }
  if (dirty.length !== 0) throw new Error(`Dirty product-index months remain: ${dirty.length}.`);
  if (adjustments.length !== 0) throw new Error("Synthetic adjustments leaked into the product index.");
  return summary;
}

progress(
  `POS電子ジャーナル バックフィル ${apply ? "--apply (本番データを書き換えます)" : "--dry-run (DBは変更しません)"}` +
    ` / parser ${PARSER_VERSION}`,
);
const serviceRoleKey = loadServiceRoleKey();
const dryRunResults = [];
for (const target of TARGETS) {
  dryRunResults.push(await reparseStore(serviceRoleKey, target, true));
}

// reparse dry-runはStorage原本をv21で検算するだけで、DBのparsed_dataは更新しない。
// coverageはapply後の新しいparsed_dataに対して検証する。

if (!apply) {
  progress("dry-run 完了。DBは変更していません。適用するには --apply を付けて再実行してください。");
  console.log(JSON.stringify({ ok: true, mode: "dry-run", parser_version: PARSER_VERSION, stores: dryRunResults }, null, 2));
  process.exit(0);
}

const applyResults = [];
for (const target of TARGETS) {
  applyResults.push(await reparseStore(serviceRoleKey, target, false));
  await rebuildStore(serviceRoleKey, target, true);
  await rebuildStore(serviceRoleKey, target, false);
}
const verified = await verifyProduction(serviceRoleKey);
progress("apply 完了。全店舗で検証を通過しました。");
console.log(JSON.stringify({
  ok: true,
  mode: "apply",
  parser_version: PARSER_VERSION,
  dry_run: dryRunResults,
  applied: applyResults,
  verified,
}, null, 2));
