#!/usr/bin/env node
/**
 * 既存 saved_reports の巨大 body/previewHtml を Storage（pos-report-html）へ退避する。
 * 数値フィールド（KPI / sales / journalIds）は触らない。
 *
 * 使い方:
 *   ADMIN_TOKEN=... STORE_KEY=bistrocavacava node supabase/scripts/offload-saved-report-html.mjs
 *   ADMIN_TOKEN=... STORE_KEY=bistrocavacava LIMIT=50 node supabase/scripts/offload-saved-report-html.mjs
 *
 * 環境変数:
 *   ADMIN_TOKEN  … x-admin-token（必須）
 *   STORE_KEY    … 店舗キー（必須）
 *   LIMIT        … 1回あたりの退避件数（既定 30、最大 100）
 *   LOOPS        … 繰り返し回数（既定 20。0件になるまで回す想定）
 *   ADMIN_API_BASE … 例 https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/admin-api
 */
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim();
const STORE_KEY = String(process.env.STORE_KEY || '').trim();
const LIMIT = Math.max(1, Math.min(100, Number(process.env.LIMIT || 30) || 30));
const LOOPS = Math.max(1, Math.min(200, Number(process.env.LOOPS || 20) || 20));
const ADMIN_API_BASE = String(
  process.env.ADMIN_API_BASE ||
    'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/admin-api',
).replace(/\/$/, '');

if (!ADMIN_TOKEN || !STORE_KEY) {
  console.error('ADMIN_TOKEN and STORE_KEY are required.');
  process.exit(1);
}

async function offloadOnce() {
  const res = await fetch(`${ADMIN_API_BASE}/pos-journals/saved-reports/html-offload`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-admin-token': ADMIN_TOKEN,
      'x-admin-surface': 'line_report',
    },
    body: JSON.stringify({ store_key: STORE_KEY, limit: LIMIT }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body;
}

let totalOffloaded = 0;
for (let i = 1; i <= LOOPS; i++) {
  const result = await offloadOnce();
  const offloaded = Number(result.offloaded) || 0;
  const failed = Number(result.failed) || 0;
  totalOffloaded += offloaded;
  console.log(
    `[${i}/${LOOPS}] scanned=${result.scanned} offloaded=${offloaded} skipped=${result.skipped} failed=${failed}`,
  );
  if (offloaded === 0) {
    console.log('No more reports to offload.');
    break;
  }
  if (failed > 0) {
    console.warn('Some rows failed:', (result.results || []).filter((r) => r && !r.ok).slice(0, 5));
  }
}

console.log(`Done. total_offloaded=${totalOffloaded}`);
