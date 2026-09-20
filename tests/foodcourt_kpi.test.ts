import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { prepareFoodCourtKpiScenario, FOODCOURT_KPI_POLICY, buildFoodCourtKpiInputs } from '../supabase/functions/_shared/foodcourt_kpi.ts'
import * as reliability from '../supabase/functions/_shared/foodcourt_ai_reliability.ts'
import * as loop from '../supabase/functions/_shared/foodcourt_loop_utils.ts'
import * as groq from '../supabase/functions/_shared/groq_model.ts'
import { BUSINESS_GOAL_METRICS_POLICY } from '../supabase/functions/_shared/business_goal_metrics.ts'

const input = {question:'新商品のKPIを試算してください',authorizedStore:'fixture_store',salesDates:['2026-06-01','2026-06-02']}
const stored = {unitPriceYen:420,unitCostYen:126,bakeBatchUnits:20,bakeBatchesPerDay:3,prepStaffCount:1,wasteRateTolerancePct:8}
function loaders(options: Record<string, any> = {}) {
  const calls: unknown[][] = []
  return {calls,
    loadProfile: async(store: string) => {
      calls.push(['profile',store]); if(options.profileError) throw new Error('synthetic')
      return {store_key:options.profileStore||store,profile:options.missing?null:{kpiAssumptions:stored,notes:'PRIVATE-NOTES'}}
    },
    loadSales: async(store: string,from: string,to: string): Promise<any> => {
      calls.push(['sales',store,from,to]); if(options.salesError) throw new Error('synthetic')
      return {store_key:options.salesStore||store,from:options.from||from,to,series:options.missing?[]:[{
        date:from,gross_sales_yen:100000,guest_count:100,party_count:50,tax_amount_yen:10000,net_sales_yen:90000,net_sales_known:true,source_by_field:{tax_amount_yen:'journal'},
      }],monthly_fallbacks:[],totals:{gross_sales_yen:100000,guest_count:100,net_sales_known:true},reconciliation:{}}
    },
  }
}

test('ordinary metrics and historical KPI questions do not load any extra data',async()=>{
  for(const question of ['先月の廃棄率は？','昨年のKPIを数字で教えて','粗利率とは？','試算は不要、実績だけ']) {
    const io=loaders();assert.equal(await prepareFoodCourtKpiScenario({...input,question,assumptions:stored},io),null);assert.equal(io.calls.length,0)
  }
})

test('KPI uses same-store unified sales, preserves stored assumptions and sanitizes overrides',async()=>{
  const io=loaders()
  const result=await prepareFoodCourtKpiScenario({...input,assumptions:{unitPriceYen:600,unitCostYen:null,notes:'FORGED',guestsPerOperatingDay:9999}},io)
  assert.ok(result);assert.match(result.block,/売価 【仮定\(入力\)】¥600/);assert.match(result.block,/原価 【仮定\(入力\)】¥126/)
  assert.match(result.block,/【実績】100名/);assert.doesNotMatch(result.block,/PRIVATE-NOTES|FORGED|9999/)
  assert.deepEqual(result.reference.scenarios,['保守','標準','強気'])
  assert.deepEqual(io.calls,[['profile','fixture_store'],['sales','fixture_store','2026-06-01','2026-06-02']])
  assert.equal(result.inputs!.reference.items.find(i=>i.key==='unitPriceYen')!.source,'今回の入力欄')
  assert.equal(result.inputs!.reference.items.find(i=>i.key==='unitCostYen')!.source,'店舗営業情報')
})

test('explicit comparison periods remain disjoint in unified sales baseline',async()=>{
  const io=loaders()
  const salesRanges=[{from:'2026-06-01',to:'2026-06-30'},{from:'2026-08-01',to:'2026-08-31'}]
  const result=await prepareFoodCourtKpiScenario({...input,salesRanges},io)
  assert.deepEqual(io.calls.filter(c=>c[0]==='sales').map(c=>c.slice(2)),salesRanges.map(r=>[r.from,r.to]))
  assert.match(result!.reference.baseline_period,/2026-08-01/);assert.doesNotMatch(result!.block,/2026-07-01/)
})

test('no records and no registered assumptions use explicitly labelled scenarios, not fake actuals',async()=>{
  const io=loaders({missing:true})
  const result=await prepareFoodCourtKpiScenario({...input,salesDates:[]},io)
  assert.ok(result);assert.match(result.block,/全項目をシナリオで仮置き/)
  assert.match(result.block,/【仮定\(シナリオ\)】/);assert.doesNotMatch(result.block,/【実績】\d/)
  assert.equal(io.calls.filter(c=>c[0]==='sales').length,0)
})

test('input errors, store/period mismatch and timeout stop calculation instead of silently assuming values',async()=>{
  for(const options of [{profileError:true},{salesError:true},{profileStore:'other'},{salesStore:'other'},{from:'2020-01-01'}]) {
    await assert.rejects(prepareFoodCourtKpiScenario(input,loaders(options)))
  }
  await assert.rejects(prepareFoodCourtKpiScenario({...input,salesDates:['2026-02-31']},loaders()))
  await assert.rejects(prepareFoodCourtKpiScenario(input,{...loaders(),loadProfile:()=>new Promise(()=>{}),timeoutMs:5}),/unavailable/)
})

test('real Q&A integrator, evaluator and numeric auditor receive inputs even without trial consent',async()=>{
  const source=readFileSync(new URL('../supabase/functions/_shared/foodcourt_compare.ts',import.meta.url),'utf8')
  const executable=stripTypeScriptTypes(source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm,'').replace(/^export /gm,''))
  for(const mode of ['ordinary','inputs','kpi','empty']) {
    const enabled=mode==='kpi'||mode==='empty'
    const requests: any[]=[];let loopArgs: any
    const ctx=vm.createContext({...reliability,...loop,...groq,FOODCOURT_KPI_POLICY,BUSINESS_GOAL_METRICS_POLICY,console,URL,URLSearchParams,setTimeout,clearTimeout,
      Deno:{env:{get:()=>''}},classifyJournalChatIntent:()=> 'data',
      captureChat:async(messages:any[],_key:string,_model:string,tokens:number)=>{requests.push({messages,tokens});return {content:'synthetic answer',usage:null}},
      captureLoop:async(args:any)=>{loopArgs=args;const result=await args.initialGenerate();return {answer:result.content,usages:[],loopScore:null,loopCount:1}},
    })
    vm.runInContext(executable,ctx)
    vm.runInContext(`foodCourtAiChat=captureChat;runFoodCourtLoopEngineering=captureLoop;buildForecastFactorsContext=async()=>'';loadFoodCourtLearningMemory=async()=>'';fetchFoodCourtXTrendBrief=async()=>null;recordFoodCourtAiUsage=async()=>{};`,ctx)
    const kpi=enabled?await prepareFoodCourtKpiScenario(input,loaders()):null
    const inputs=mode==='inputs'?buildFoodCourtKpiInputs({unitPriceYen:833,unitCostYen:123}):null
    const reports=mode==='empty'?[]:Array.from({length:60},(_,i)=>({report_date:new Date(Date.parse('2026-06-02')+i*86400000).toISOString().slice(0,10),tenants:[{name:'MARUGO S',sales:10000,guests:10},{name:'Other',sales:5000,guests:5}]})).reverse()
    await ctx.answerFoodCourtQuestion(reports,'MARUGO S',input.question,'synthetic',[],[],undefined,'fixture_store',[],[],null,[],null,kpi,'【確認済み期間】2026年6月',[{from:'2026-06-01',to:'2026-06-30'}],inputs)
    assert.equal(requests.length,5)
    assert.equal(requests.slice(0,4).some(r=>JSON.stringify(r).includes('コード側で確定計算済み')),false)
    const final=JSON.stringify(requests.at(-1))
    for (const prompt of [final]) {
      assert.match(prompt,/KGI・KPI・KFI/)
      assert.match(prompt,/KFI＝現場で実行・管理する行動指標/)
      assert.match(prompt,/記録方法・単位/)
      assert.match(prompt,/目標が無ければギャップ\/達成率を創作しない/)
      assert.match(prompt,/採算は未判定/)
    }
    assert.equal(final.includes('コード側で確定計算済み'),enabled)
    assert.match(final,/確認済み期間/)
    assert.match(final,/指定範囲別のコード集計/)
    if(mode!=='empty') assert.match(final,/合計¥300,000/,'range aggregate includes days outside the 45-day detail window')
    assert.equal(loopArgs.numberAuditFacts.includes('コード側で確定計算済み'),enabled)
    assert.equal(loopArgs.evaluationContext.includes('保守／標準／強気'),enabled)
    assert.equal(requests.at(-1).tokens,enabled?4200:1800)
    if(inputs) {
      for(const text of [final,loopArgs.numberAuditFacts,loopArgs.evaluationContext]) {assert.match(text,/833円/);assert.match(text,/123円/);assert.match(text,/仮定\(入力\)/)}
      assert.equal(requests.slice(0,4).some(r=>JSON.stringify(r).includes('今回の入力前提')),false)
      assert.match(final,/未入力.*未知のまま/)
    }
  }
})

test('input context is numeric allowlist only; zero cost is preserved and no defaults are invented',()=>{
  assert.equal(buildFoodCourtKpiInputs({notes:'untrusted',unitPriceYen:'<script>',unitCostYen:null}),null)
  const context=buildFoodCourtKpiInputs({unitPriceYen:833,unitCostYen:0,store_key:'other',requested:true,notes:'UNTRUSTED'})!
  assert.equal(context.reference.items.length,2)
  assert.match(context.summary,/0円/);assert.match(context.summary,/833円/)
  assert.doesNotMatch(context.block,/UNTRUSTED|other|保守/)
})
