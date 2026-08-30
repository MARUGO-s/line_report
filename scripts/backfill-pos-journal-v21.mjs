#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const PROJECT_REF = "hocbnifuactbvmyjraxy";
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const ADMIN_API_URL = `${SUPABASE_URL}/functions/v1/admin-api`;
const PARSER_VERSION = "2026-08-30-v21";
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

function loadServiceRoleKey() {
  let raw;
  try {
    raw = execFileSync(
      "npx",
      [
        "supabase",
        "projects",
        "api-keys",
        "--project-ref",
        PROJECT_REF,
        "--output",
        "json",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    throw new Error("Supabase API keys could not be loaded. Check CLI login and project access.");
  }
  let rows;
  try {
    const parsed = JSON.parse(raw);
    rows = Array.isArray(parsed) ? parsed : parsed?.api_keys || parsed?.keys || [];
  } catch {
    throw new Error("Supabase API key response was not valid JSON.");
  }
  const key = rows.find((row) => row?.name === "service_role" && row?.type === "legacy")?.api_key;
  if (typeof key !== "string" || !key.startsWith("eyJ")) {
    throw new Error("The legacy service_role key was not available.");
  }
  return key;
}

async function callAdmin(serviceRoleKey, path, body) {
  const response = await fetch(`${ADMIN_API_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
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
      if (attempt < MAX_BATCH_ATTEMPTS) await sleep(attempt * 1500);
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
  const response = await fetch(url, {
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${table} verification failed with HTTP ${response.status}.`);
  return response.json();
}

async function verifyProduction(serviceRoleKey) {
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
      parser_v21: parserFiles,
      months_complete: storeCoverage.length,
      coverage_scanned_days: coverageScannedDays,
      gross,
    });
  }
  if (dirty.length !== 0) throw new Error(`Dirty product-index months remain: ${dirty.length}.`);
  if (adjustments.length !== 0) throw new Error("Synthetic adjustments leaked into the product index.");
  return summary;
}

const serviceRoleKey = loadServiceRoleKey();
const dryRunResults = [];
for (const target of TARGETS) {
  dryRunResults.push(await reparseStore(serviceRoleKey, target, true));
}

// reparse dry-runはStorage原本をv21で検算するだけで、DBのparsed_dataは更新しない。
// coverageはapply後の新しいparsed_dataに対して検証する。

if (!apply) {
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
console.log(JSON.stringify({
  ok: true,
  mode: "apply",
  parser_version: PARSER_VERSION,
  dry_run: dryRunResults,
  applied: applyResults,
  verified,
}, null, 2));
