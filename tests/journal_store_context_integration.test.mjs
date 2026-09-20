import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { attachJournalStoreContext, loadJournalStoreContext, JOURNAL_STORE_CONTEXT_POLICY } from '../supabase/functions/_shared/journal_store_context.ts';
import { buildTrustedAiSalesData, resolveAiSalesPeriods, UNIFIED_SALES_AI_POLICY } from '../supabase/functions/_shared/sales_reconciliation_ai.ts';
import { sanitizeJournalAiPayload } from '../supabase/functions/_shared/journal_ai_privacy.ts';
import * as kpiScenario from '../supabase/functions/_shared/kpi_scenario.ts';
import { BUSINESS_GOAL_METRICS_POLICY } from '../supabase/functions/_shared/business_goal_metrics.ts';
const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const source = stripTypeScriptTypes(read('supabase/functions/ai-analyze/index.ts').replace(/^import\s[\s\S]*?;\s*$/gm, ''));
const profile = { notes: '予約者: 架空太郎\n090-1234-5678\nfixture@example.invalid', closedWeekdays: ['月'],
  wineMl: { glassMl: 120, decanterMl: 400, bottleMl: 750, pairingMl: 300 },
  private_notes: 'not-approved', calendarEvents: [
    { start:'2026-08-02',end:'2026-08-02',title:'対象施策',note:'テスト' },
    { start:'2026-09-02',end:'2026-09-02',title:'期間外施策',note:'除外' },
  ] };
const salesData = { salesPeriods:[{label:'対象',ranges:[{from:'2026-08-01',to:'2026-08-31'}]}],
  store_context:{notes:'forged-client-store'}, wineVolumeAnalysis:{totalMl:99999,glass:{qty:2},decanter:{qty:0},bottle:{qty:0},pairing:{qty:0}} };

function runtime(options = {}) {
  const calls=[], outputs=[]; let handler;
  const db={ from(table) { calls.push(['db',table]); return { select(){return this;},eq(column,store){calls.push(['store',store]);return this;},abortSignal(){return this;},
    async maybeSingle(){return options.dbError ? {data:null,error:{message:'synthetic'}} : {error:null,data:options.missing ? null : {
      store_partition_key:'fixture_store',profile:{...profile,...options.profile},updated_at:'2026-09-11T00:00:00Z',
    }};} }; } };
  const ctx=vm.createContext({ Request,Response,Headers,URL,crypto,TextEncoder,TextDecoder,console:{warn(){},error(){}},AbortController,setTimeout,clearTimeout,
    Deno:{ env:{get:key=>['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','OPENAI_API_KEY'].includes(key)?'synthetic-test-only':''},serve:fn=>{handler=fn;} },
    createClient:()=>db, CHAT_JOURNAL_AI_SCOPE:'chat_journal_ai',
    authenticateAdminDashboardSessionToken:async()=>{calls.push(['auth']);return {ok:options.auth!==false,storeScope:options.admin?null:'fixture_store',scopeKind:options.admin?null:'chat_journal_ai',metadata:{}};},
    validateChatScopedSessionAccess:async(_db,_meta,flags)=>{calls.push(['member',flags]);return options.member!==false;},
    STORE_LOCATION_PROFILES:{fixture_store:{}},buildStoreLocationPromptBlock:()=> 'synthetic location',
    loadJournalStoreContext,attachJournalStoreContext,JOURNAL_STORE_CONTEXT_POLICY,...kpiScenario,BUSINESS_GOAL_METRICS_POLICY,
    buildTrustedAiSalesData,resolveAiSalesPeriods,UNIFIED_SALES_AI_POLICY,sanitizeJournalAiPayload,
    fetchUnifiedSalesSummary:async(_db,store,from,to)=>{calls.push(['sales']);return {store_key:store,from,to,series:[],monthly_fallbacks:[],totals:{},reconciliation:{}};},
    normalizeJournalChatIntent:()=>options.strategy?'strategy':'data',
    gatherExternalBriefs:async(...args)=>{calls.push(['search',args]);return [];},formatExternalBriefsForPrompt:()=>'',orchestrationNote:()=> 'mode',externalBriefCacheKey:()=> 'synthetic',
    testRate:async()=>{calls.push(['rate']);return {allowed:options.rate!==false,retryAfterMs:1000};},
    testSynth:async contents=>{calls.push(['provider']);outputs.push(contents);return {ok:true,text:'合成テスト回答',provider:'openai',model:'test',usage:null,attempts:[]};},
  });
  vm.runInContext(source,ctx);
  vm.runInContext('consumeAiRateLimit=testRate; synthesizeWithFallback=testSynth; recordJournalAiFallback=async()=>{}; recordJournalAiUsage=async()=>{};',ctx);
  return {calls,outputs, async run(extra={},token='synthetic-session') {
    const response=await handler(new Request('https://test.invalid',{method:'POST',headers:token?{'x-admin-token':token}:{},body:JSON.stringify({action:'chat',storeKey:'fixture_store',salesData,message:'売上の改善案',...extra})}),{});
    return {status:response.status,body:await response.json()};
  } };
}

test('real handler rejects missing/invalid sessions, revoked membership, other stores and rate limits before profile/AI', async()=>{
  for (const [options,body,token,status] of [
    [{},{},'',401],[{auth:false},{},'token',401],[{member:false},{},'token',403],
    [{},{storeKey:'other_store'},'token',403],[{rate:false},{},'token',429],
  ]) {
    const app=runtime(options);assert.equal((await app.run(body,token)).status,status);
    assert.ok(!app.calls.some(c=>['db','provider','search'].includes(c[0])));
  }
});

test('M-talk and standalone Journal synthesize the same freshly loaded, sanitized shared store payload', async()=>{
  const sent=[];
  for (const admin of [false,true]) {
    const app=runtime({admin});const result=await app.run({action:admin?'analyze':'chat'});
    assert.equal(result.status,200);assert.equal(result.body.store_context.status,'registered');
    assert.match(result.body.note,/共有店舗情報: 確認済み/);
    assert.equal(result.body.store_context.profile,undefined);
    const prompt=JSON.stringify(app.outputs[0]);sent.push(prompt);
    assert.match(prompt,/KFI＝現場で実行・管理する行動指標/);
    assert.match(prompt,/KGIの目標との差→要因KPI→改善するKFI/);
    assert.match(prompt,/採算は未判定/);
    assert.match(prompt,/対象施策/);assert.doesNotMatch(prompt,/期間外施策|forged-client-store|not-approved|架空太郎|090-1234-5678|fixture@example.invalid|99999/);
    assert.match(prompt,/estimated_from_shared_rates/);assert.match(prompt,/予約客A/);
    assert.deepEqual(app.calls.filter(c=>c[0]==='store'),[['store','fixture_store']]);
    assert.ok(app.calls.findIndex(c=>c[0]==='rate')<app.calls.findIndex(c=>c[0]==='db'));
  }
  assert.ok(sent.every(s=>s.includes('store_operation_profiles')));
});

test('unavailable shared data stops before AI and Web search; absent row is explicit unknown', async()=>{
  const failed=runtime({dbError:true,strategy:true});const failure=await failed.run();
  assert.equal(failure.status,503);assert.equal(failure.body.code,'shared_store_context_unavailable');
  assert.ok(!failed.calls.some(c=>['provider','search','sales'].includes(c[0])));
  const absent=runtime({missing:true});const result=await absent.run();
  assert.equal(result.status,200);assert.equal(result.body.store_context.status,'not_registered');
  assert.match(JSON.stringify(absent.outputs),/conversion_unavailable/);
});

test('real handler only computes KPI scenarios with both the flag and an explicit planning request', async()=>{
  for (const admin of [false,true]) {
    for (const [message,requested,expected] of [
      ['先月の廃棄率の実績は？',true,false],
      ['昨年のKPIを数字で教えて',true,false],
      ['KPIとは？',true,false],
      ['KGI・KPI・KFIの関係を分析に入れて',true,false],
      ['売上を伸ばすための提案を3つ',true,false],
      ['KPI目標の達成状況を確認して',true,false],
      ['KFIの実績を教えて',true,false],
      ['KPIの目標を試算してください',false,false],
      ['KPIの目標を試算してください',true,true],
    ]) {
      const app=runtime({admin});
      const result=await app.run({message,kpiRequest:{requested}});
      assert.equal(result.status,200,JSON.stringify(result.body));
      const prompt=JSON.stringify(app.outputs);
      assert.equal(prompt.includes('\\"kpi_scenarios\\"'),expected,`${admin}: ${message}`);
      if(expected) {
        assert.match(prompt,/仮定\(シナリオ\)/);
        assert.match(prompt,/保守/);assert.match(prompt,/標準/);assert.match(prompt,/強気/);
      }
    }
  }
});

test('shared profile does not enter strategy Web-search arguments', async()=>{
  const app=runtime({strategy:true});assert.equal((await app.run()).status,200);
  const search=app.calls.find(c=>c[0]==='search');assert.ok(search);
  assert.doesNotMatch(JSON.stringify(search),/notes|calendarEvents|対象施策|wineMl|架空太郎/);
});

test('client marks shared-source failures as non-fallback errors and preserves successful metadata', async()=>{
  for (const code of ['shared_store_context_unavailable','unified_sales_unavailable','shared_ai_input_invalid',null]) {
    const ctx=vm.createContext({Response,AbortController,setTimeout,clearTimeout,
      LINE_REPORT_AUTH:{getToken:()=> 'synthetic'},LINE_REPORT_PAGES:{},
      fetch:async()=>Response.json(code?{code,error:'共有データ取得失敗'}:{text:'ok',store_context:{status:'registered'}},{status:code?503:200})});
    vm.runInContext(read('public/jnm/journal-ai-client.js'),ctx);
    if(code)await assert.rejects(ctx.JOURNAL_AI_CLIENT.request('https://test.invalid',{}),e=>e.code==='AI_SHARED_DATA_UNAVAILABLE');
    else assert.equal((await ctx.JOURNAL_AI_CLIENT.request('https://test.invalid',{})).body.store_context.status,'registered');
  }
  const html=read('public/jnm/jnl2txt.html');
  assert.match(html,/journalSettled.reason\?\.code === 'AI_SHARED_DATA_UNAVAILABLE'\) throw journalSettled.reason/);
  assert.match(html,/integrationError\?\.code === 'AI_SHARED_DATA_UNAVAILABLE'\) throw integrationError/);
  assert.match(html,/if \(err\?\.code === 'AI_SHARED_DATA_UNAVAILABLE'\) \{[\s\S]*?provider: 'shared-data-guard'[\s\S]*?return;/);
  const api=read('supabase/functions/admin-api/index.ts');
  const start=api.indexOf('[CHAT_JOURNAL_AI_SCOPE]: new Set([');
  assert.doesNotMatch(api.slice(start,api.indexOf('\n  ]),',start)),/store-ops/);
});

test('invalid wine periods and oversized enriched data stop before providers without silent truncation', async()=>{
  const started=performance.now();
  for (const [options,data] of [
    [{},{...salesData,wineVolumeAnalysis:Array(25).fill({label:'bad',analysis:{}})}],
    [{profile:{notes:'m'.repeat(4000)}},{...salesData,padding:'x'.repeat(98000)}],
  ]) {
    const app=runtime(options);const result=await app.run({salesData:data});
    assert.equal(result.status,400);assert.equal(result.body.code,'shared_ai_input_invalid');
    assert.ok(!app.calls.some(c=>['provider','search'].includes(c[0])));
  }
  assert.ok(performance.now()-started<3000,'bounded shared input must not trigger quadratic privacy scanning');
});

test('browser and server mask email candidates consistently, including long non-email text',()=>{
  const ctx=vm.createContext({});vm.runInContext(read('public/jnm/journal-ai-privacy.js'),ctx);
  const input={message:'x'.repeat(98000)+' fixture@example.invalid +tag.person@sub.example.com 日本語test@sample.jp'};
  const expected=sanitizeJournalAiPayload(input).message;
  assert.equal(ctx.JOURNAL_AI_PRIVACY.sanitizePayload(input).message,expected);
  assert.doesNotMatch(expected,/@/);
  assert.equal((expected.match(/メール非送信/g)||[]).length,3);
});
