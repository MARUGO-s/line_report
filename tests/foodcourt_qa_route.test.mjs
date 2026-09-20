import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {prepareFoodCourtKpiScenario} from '../supabase/functions/_shared/foodcourt_kpi.ts';
import {isKpiScenarioRequest} from '../supabase/functions/_shared/kpi_scenario.ts';
import {resolveAiSalesPeriods} from '../supabase/functions/_shared/sales_reconciliation_ai.ts';
const source=readFileSync(new URL('../supabase/functions/admin-api/index.ts',import.meta.url),'utf8');
const start=source.indexOf('    if (req.method === "POST" && (path === "/foodcourt/ask"');
const end=source.indexOf('    if (req.method === "GET" && path === "/foodcourt/qa-history")',start);
assert.ok(start>0 && end>start);
const wrapped=stripTypeScriptTypes('async function route(){\n'+source.slice(start,end)+'\n}');
const code=wrapped.slice(wrapped.indexOf('{')+1,wrapped.lastIndexOf('}'));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const dateAdd=(d,n)=>new Date(Date.parse(d)+n*86400000).toISOString().slice(0,10);
function runtime(options={}) {
  const queries=[],calls=[];let sent,inserted;
  const rows=options.rows||[
    {id:1,report_date:'2026-06-02',base_tenant_name:'Fixture'},
    {id:2,report_date:'2026-07-02',base_tenant_name:'Fixture'},
    {id:3,report_date:'2026-08-02',base_tenant_name:'Fixture'},
    {id:4,report_date:'2026-06-02',base_tenant_name:'Fixture'},
  ];
  const deps={
    req:{method:'POST'},path:'/foodcourt/ask',url:new URL('https://test.invalid'),
    json:(body,status)=>({body,status}),crypto,console,
    isStrictIsoDate:d=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&new Date(d).toISOString().slice(0,10)===d,
    resolveAiSalesPeriods,isKpiScenarioRequest,prepareFoodCourtKpiScenario,
    normalizePosJournalStoreKey:s=>s.toLowerCase(),
    Deno:{env:{get:()=> 'synthetic-only'}},addDaysIso:dateAdd,jstDateIso:n=>dateAdd('2026-09-20',n),
    fcSalesDate:r=>dateAdd(r.report_date,-1),
    supabase:{from(table){queries.push(['table',table]);const q={select(){return q},ilike(...a){queries.push(['ilike',...a]);return q},order(){return q},limit(n){queries.push(['limit',n]);return q},gte(...a){queries.push(['gte',...a]);return q},lte(...a){queries.push(['lte',...a]);return q},then(resolve){return Promise.resolve({data:rows,error:null}).then(resolve)},insert(value){inserted=value;return q},single:async()=>({data:{id:9},error:null})};return q;}},
    loadVenueEventsForReports:async()=>{calls.push('events');return []},loadWeatherForReports:async()=>[],loadForecastForStore:async()=>[],
    loadFoodCourtDailyLogs:async()=>({logs:[{log_date:'2026-06-01'},{log_date:'2026-07-01'},{log_date:'2026-08-01'}],count:3,error:null}),
    loadJournalStoreContext:async(_db,store)=>{calls.push('profile');if(options.profileError)throw Error('synthetic');return {store_key:store,profile:null}},
    fetchUnifiedSalesSummary:async(_db,store,from,to)=>{calls.push(['sales',store,from,to]);return {store_key:store,from,to,series:[],monthly_fallbacks:[],totals:{},reconciliation:{}}},
    answerFoodCourtQuestion:async(...args)=>{calls.push('ai');sent=args;return {answer:'synthetic answer',loopScore:null,loopCount:1}},
  };
  return {queries,calls,get sent(){return sent},get inserted(){return inserted},run:async(body)=>{
    const all={...deps,workReq:{json:async()=>({store_key:'fixture_store',question:'売上の傾向を教えて',...body})}};
    return new AsyncFunction(...Object.keys(all),code)(...Object.values(all));
  }};
}

test('real Q&A route filters comparison periods, shifts report dates once, removes duplicate days and filters logs',async()=>{
  const app=runtime();const result=await app.run({period_mode:'range',requested_ranges:[{from:'2026-06-01',to:'2026-06-30'},{from:'2026-08-01',to:'2026-08-31'}],viewing_report_id:2});
  assert.equal(result.status,200);
  assert.deepEqual(app.sent[0].map(r=>r.id),[1,3]);
  assert.deepEqual(app.sent[11].map(r=>r.log_date),['2026-06-01','2026-08-01']);
  assert.equal(app.sent[10],null,'viewing day must not override selected period');
  assert.match(app.sent[14],/2026-08-31/);
  assert.deepEqual(app.sent[15],[{from:'2026-06-01',to:'2026-06-30'},{from:'2026-08-01',to:'2026-08-31'}]);
  assert.ok(app.queries.some(q=>q[0]==='gte' && q[2]==='2026-06-02'));
  assert.ok(app.queries.some(q=>q[0]==='lte' && q[2]==='2026-09-01'));
  assert.equal(app.calls.includes('profile'),false,'ordinary questions do not load assumptions');
  assert.equal(app.inserted.source_ref.period.report_count,2);
});

test('tampered period modes, invalid dates, overlaps and missing ranges are rejected before DB/AI',async()=>{
  for(const body of [
    {period_mode:'all',requested_ranges:[{from:'2026-06-01',to:'2026-06-30'}]},
    {period_mode:'range',requested_ranges:[]},
    {period_mode:'bad',requested_ranges:[]},
    {period_mode:'range',requested_ranges:[{from:'2026-07-02',to:'2026-07-01'}]},
    {period_mode:'range',requested_ranges:[{from:'2026-07-01suffix',to:'2026-07-02'}]},
    {period_mode:'range',requested_ranges:[{from:'2026-06-01',to:'2026-06-30'},{from:'2026-06-01',to:'2026-06-30'}]},
  ]) {const app=runtime();assert.equal((await app.run(body)).status,400);assert.equal(app.queries.length,0);assert.equal(app.calls.length,0)}
});

test('KPI profile failure is HTTP 503 before providers and untrusted body flags cannot enable KPI',async()=>{
  const failed=runtime({profileError:true});
  assert.equal((await failed.run({question:'新商品のKPIを試算してください'})).status,503);
  assert.equal(failed.calls.includes('ai'),false);assert.equal(failed.calls.includes('events'),false);
  const ordinary=runtime();
  const result=await ordinary.run({question:'粗利率とは？',kpiRequest:{requested:true},kpi_assumptions:{unitPriceYen:9999}});
  assert.equal(result.status,200);assert.equal(ordinary.sent[13],null);assert.equal(ordinary.calls.includes('profile'),false);
});

test('KPI can be generated without comparison reports and reference metadata is saved',async()=>{
  const app=runtime({rows:[]});const result=await app.run({question:'新商品のKPIを試算してください',period_mode:'all',requested_ranges:[]});
  assert.equal(result.status,200);assert.ok(app.sent[13].block.includes('仮定(シナリオ)'));
  assert.equal(app.inserted.source_ref.kpi_scenarios.status,'computed_server_side');
  assert.equal(result.body.kpi_scenarios.status,'computed_server_side');
});

test('all-period cap is explicit and cannot claim full coverage',async()=>{
  const app=runtime({rows:Array.from({length:500},(_,i)=>({id:i,report_date:'2026-06-02'}))});
  const result=await app.run({period_mode:'all',requested_ranges:[]});
  assert.equal(result.body.period.truncated,true);assert.match(result.body.answer,/一部のみ/);
});
