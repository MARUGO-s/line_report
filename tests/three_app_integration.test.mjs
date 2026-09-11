import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const html = read('public/jnm/jnl2txt.html');
const api = read('supabase/functions/admin-api/index.ts');
const chunk = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));

test('three apps and active public assets contain only the shared Supabase project', () => {
  const walk = (path) => readdirSync(new URL('../' + path, import.meta.url), { withFileTypes: true }).flatMap(f =>
    f.isDirectory() ? (['vendor', 'system-map'].includes(f.name) ? [] : walk(path + '/' + f.name)) : [path + '/' + f.name]);
  let hosts = 0;
  for (const path of walk('public').filter(p => /\.(html|js)$/.test(p))) {
    for (const match of read(path).matchAll(/https:\/\/([a-z0-9]{20})\.supabase\.co/g)) {
      hosts++; assert.equal(match[1], 'hocbnifuactbvmyjraxy', path);
    }
  }
  assert.ok(hosts >= 5);
});

test('Journal pages load common config and scoped auth once, without stale local replacement', () => {
  for (const page of ['jnl2txt.html', 'ai-usage.html', 'ai-chat-pdf-history.html']) {
    for (const script of ['auth-session.js', 'pages-config.js']) {
      const source = read('public/jnm/' + page);
      const paths = [...source.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]);
      assert.equal(paths.filter(p => p.endsWith(script)).length, 1);
      assert.ok(paths.includes('../' + script));
    }
  }
});

function cacheRuntime(fetch) {
  const ctx = vm.createContext({ URLSearchParams, console: {warn(){},error(){}}, STORE_KEY: 'bistrocavacava',
    savedReportsIndexCache: new Map(), savedReportDetailCache: new Map(),
    SAVED_REPORTS_INDEX_TTL_MS: 90000, SAVED_REPORT_DETAIL_TTL_MS: 600000,
    savedReportsLoadError: null, isCategoryOverridesReportId: () => false,
    pickDefinedSummary: () => ({}), adminApiFetch: fetch });
  vm.runInContext(chunk(html, 'async function fetchSupabaseReports(', 'async function hydrateSavedReport('), ctx);
  return ctx;
}

test('expired index and detail are not returned after 403, 404 or server failure', async () => {
  for (const status of [403, 404, 500]) {
    const ctx = cacheRuntime(async () => { throw new Error(String(status)); });
    ctx.savedReportsIndexCache.set('bistrocavacava|monthly|500', {time: 0, rows: [{ id: 'old' }]});
    ctx.savedReportDetailCache.set('bistrocavacava|old', {time: 0, report: {id: 'old', total: 100}});
    assert.equal(await ctx.fetchSupabaseReports({kind: 'monthly'}), null);
    assert.equal(await ctx.fetchSupabaseReportById('old'), null);
    assert.match(ctx.savedReportsLoadError.message, new RegExp(String(status)));
    assert.equal(ctx.savedReportDetailCache.size, 0);
  }
});

test('force refresh observes another app update and invalidates same-ID detail by revision', async () => {
  const ctx = cacheRuntime(async () => ({items: [{id:'same', updated_at:'new-revision'}]}));
  ctx.savedReportsIndexCache.set('bistrocavacava|monthly|500', {time:Date.now(), rows:[{id:'old'}]});
  ctx.savedReportDetailCache.set('bistrocavacava|same', {time:Date.now(), report:{updatedAt:'old-revision'}});
  assert.equal((await ctx.fetchSupabaseReports({kind:'monthly'}))[0].id, 'old');
  assert.equal((await ctx.fetchSupabaseReports({kind:'monthly', forceRefresh:true}))[0].id, 'same');
  assert.equal(ctx.savedReportDetailCache.size, 0);
  assert.match(api, /"created_at", "updated_at", "deleted_at"/);
});

test('saved report success and shared-sales sync failure are separate; same ID is retryable', async () => {
  let fail = true; const writes = [];
  const db = { from() { return { select(){return this;}, eq(){return this;},
    async maybeSingle(){return {data:null,error:null};},
    async upsert(row){ writes.push(row); return {error:null};} }; } };
  const ctx = vm.createContext({crypto, console:{error(){}}, toSafeString:v=>String(v??'').trim(),
    isRecord:v=>!!v&&typeof v==='object', sanitizeSavedReportDataForStorage:v=>v,
    syncJournalSalesFromReport:async()=>{if(fail)throw Error('db offline');return {enabled:true,daysWritten:1};} });
  vm.runInContext(stripTypeScriptTypes(chunk(api,'async function saveSavedReport(', 'async function deleteSavedReportItem(')),ctx);
  const input = { id:'synthetic',store_key:'BISTROCAVACAVA',data:{sales:[]} };
  const first = await ctx.saveSavedReport(db,input,null);
  assert.equal(first.ok,false); assert.equal(first.saved,true); assert.equal(first.code,'journal_sales_sync_failed');
  fail=false;
  assert.equal((await ctx.saveSavedReport(db,input,null)).ok,true);
  assert.equal(writes.length,2); assert.equal(writes[0].id,writes[1].id);
  assert.equal(writes[0].store_partition_key,'bistrocavacava');
  await assert.rejects(ctx.saveSavedReport(db,input,'sauvage'), e=>e.status===403);
});

test('Journal UI reports partial sync failure instead of all-complete', async () => {
  const ctx = vm.createContext({console:{warn(){},error(){}}, STORE_KEY:'bistrocavacava',
    getAdminToken:()=> 'synthetic-session', isDetailedReportHtml:()=>false, buildCloudReportData:v=>v,
    PAGES:{adminApiUrl:p=>'https://example.invalid'+p},FormData,AbortController,setTimeout,clearTimeout,
    fetch:async()=>Response.json({ok:false,saved:true,error:'共通売上への同期に失敗'}),
    purgeLocalCloudDataCaches(){}, invalidateSavedReportsCache(){} });
  vm.runInContext(chunk(html,'async function adminApiFetch(', '// Global Drag & Drop'),ctx);
  vm.runInContext(chunk(html,'async function writeSavedReports(', 'async function deleteSavedReport('),ctx);
  const result=await ctx.writeSavedReports([{id:'synthetic'}]);
  assert.equal(result.ok,false); assert.equal(result.remote,true);
  assert.match(result.error.message,/同期に失敗/);
});

test('unsent settings are never labeled cloud synced; M-talk settings permission is unchanged', async () => {
  const status={textContent:''};
  const ctx=vm.createContext({document:{getElementById:()=>status}, readStoreOpsForm:()=>({}),
    writeStoreOpsProfileLocal:v=>v, fillStoreOpsForm(){}, saveStoreOpsProfileToCloud:async()=>({ok:false,skipped:true})});
  vm.runInContext(chunk(html,'async function saveStoreOpsForm(', 'function resetStoreOpsForm('),ctx);
  await ctx.saveStoreOpsForm();
  assert.doesNotMatch(status.textContent,/クラウド同期済み/);
  assert.match(status.textContent,/未ログイン/);
  assert.doesNotMatch(chunk(api,'[CHAT_JOURNAL_AI_SCOPE]: new Set([', '\n  ]),'),/store-ops/);
  assert.match(chunk(html,'async function ensureStoreOpsProfileForAi(', '/**'), /if \(MTALK_EMBED\) return null/);
});
