import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { prepareFoodCourtKpiScenario, FOODCOURT_KPI_POLICY, buildFoodCourtKpiInputs, buildFoodCourtInitiativeUplift } from '../supabase/functions/_shared/foodcourt_kpi.ts'
import * as reliability from '../supabase/functions/_shared/foodcourt_ai_reliability.ts'
import * as loop from '../supabase/functions/_shared/foodcourt_loop_utils.ts'
import * as groq from '../supabase/functions/_shared/groq_model.ts'
import { BUSINESS_GOAL_METRICS_POLICY } from '../supabase/functions/_shared/business_goal_metrics.ts'
import { foodCourtAnalysisMethodPrompt } from '../supabase/functions/_shared/foodcourt_qa_methods.ts'
import {FOODCOURT_SALES_POLICY,buildFoodCourtSalesContext} from '../supabase/functions/_shared/foodcourt_sales_context.ts'
import {buildFoodCourtJournalDetail} from '../supabase/functions/_shared/foodcourt_journal_detail.ts'

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

test('new-initiative uplift is a scenario share of current store sales, not unconfirmed',()=>{
  const uplift=buildFoodCourtInitiativeUplift({
    storeDailySalesYen:174866,storePeriodLabel:'対象期間',operatingDaysPerMonth:26,
    scenarios:[
      {label:'保守',daily_sales_yen:3000,daily_units:5},
      {label:'標準',daily_sales_yen:5000,daily_units:8},
      {label:'強気',daily_sales_yen:8000,daily_units:12},
    ],
  })
  assert.ok(uplift)
  assert.match(uplift.block,/数値未確認とはしない/)
  assert.match(uplift.block,/仮定\(シナリオ\)/)
  const standard=uplift.facts.scenarios.find(s=>s.label==='標準')!
  assert.equal(standard.daily_uplift_yen,2750)
  assert.equal(standard.monthly_uplift_yen,71500)
  assert.equal(standard.store_contribution_pct,2.9)
  assert.equal(buildFoodCourtInitiativeUplift({storeDailySalesYen:100,storePeriodLabel:'x',operatingDaysPerMonth:30,scenarios:[]}),null)
})

test('ordinary metrics and historical KPI questions do not load any extra data',async()=>{
  for(const question of ['先月の廃棄率は？','昨年のKPIを数字で教えて','粗利率とは？','試算は不要、実績だけ']) {
    const io=loaders();assert.equal(await prepareFoodCourtKpiScenario({...input,question,assumptions:stored},io),null);assert.equal(io.calls.length,0)
  }
  const forced=loaders()
  assert.ok(await prepareFoodCourtKpiScenario({...input,question:'売上の傾向を教えて',force:true},forced))
  assert.ok(forced.calls.length>0)
})

test('KPI uses same-store unified sales, preserves stored assumptions and sanitizes overrides',async()=>{
  const io=loaders()
  const result=await prepareFoodCourtKpiScenario({...input,assumptions:{unitPriceYen:600,unitCostYen:null,notes:'FORGED',guestsPerOperatingDay:9999}},io)
  assert.ok(result);assert.match(result.block,/売価 【仮定\(入力\)】¥600/);assert.match(result.block,/原価 【仮定\(入力\)】¥126/)
  assert.match(result.block,/【実績】100名/);assert.match(result.block,/新しい施策の店舗売上への寄与・上積み/);assert.doesNotMatch(result.block,/PRIVATE-NOTES|FORGED|9999/)
  assert.match(result.userAppendix,/予想売価/);assert.match(result.userAppendix,/上積み\/日/)
  assert.match(result.userAppendix,/注釈: この表の数値はすべて【仮定\(シナリオ\)】/)
  const tableRows=(result.userAppendix.split('シナリオ別KGI・KPI・採算の一覧')[1]||'').split('\n').filter(line=>line.startsWith('|'))
  assert.ok(tableRows.length>2)
  assert.doesNotMatch(tableRows.join('\n'),/仮定\(シナリオ\)|仮定\(入力\)|【実績】/)
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
  for(const mode of ['ordinary','inputs','kpi','empty','journal']) {
    const enabled=mode==='kpi'||mode==='empty'
    const requests: any[]=[];let loopArgs: any
    const ctx=vm.createContext({...reliability,...loop,...groq,FOODCOURT_KPI_POLICY,FOODCOURT_SALES_POLICY,BUSINESS_GOAL_METRICS_POLICY,foodCourtAnalysisMethodPrompt,console,URL,URLSearchParams,setTimeout,clearTimeout,
      Deno:{env:{get:()=>''}},classifyJournalChatIntent:()=> 'data',
      captureChat:async(messages:any[],_key:string,_model:string,tokens:number)=>{requests.push({messages,tokens});return {content:'synthetic answer',usage:null}},
      captureLoop:async(args:any)=>{loopArgs=args;const result=await args.initialGenerate();return {answer:result.content,usages:[],loopScore:null,loopCount:1}},
    })
    vm.runInContext(executable,ctx)
    vm.runInContext(`foodCourtAiChat=captureChat;runFoodCourtLoopEngineering=captureLoop;buildForecastFactorsContext=async()=>'';loadFoodCourtLearningMemory=async()=>'';fetchFoodCourtXTrendBrief=async()=>null;recordFoodCourtAiUsage=async()=>{};`,ctx)
    const kpi=enabled?await prepareFoodCourtKpiScenario(input,loaders()):null
    const inputs=mode==='inputs'?buildFoodCourtKpiInputs({unitPriceYen:833,unitCostYen:123}):null
    const reports=mode==='empty'?[]:Array.from({length:60},(_,i)=>({report_date:new Date(Date.parse('2026-06-02')+i*86400000).toISOString().slice(0,10),tenants:[{name:'MARUGO S',sales:10000,guests:10},{name:'Other',sales:5000,guests:5}]})).reverse()
    let salesContext=null
    if(mode==='journal') {
      const range=[{from:'2025-12-09',to:'2026-08-25'}]
      salesContext=await buildFoodCourtSalesContext('fixture_store',range,loaders().loadSales)
      salesContext.journalDetail=await buildFoodCourtJournalDetail(range,'クロワッサン',async month=>month==='2025-12'?[{business_date:'2025-12-09',gross_sales:833,receipts:[{total:833,time:'11:30',items:[{code:'1001',name:'クロワッサン',qty:1,unit:833,amount:833}]}]}]:[])
    }
    const history=mode==='journal'?[{role:'user',content:'クロワッサンの導入はどう思う？'},{role:'assistant',content:'既存の軽食実績を先に見ます。'}]:[]
    await ctx.answerFoodCourtQuestion(reports,'MARUGO S',mode==='journal'?'ドリンクとの同時購入は？':input.question,'synthetic',[],[],undefined,'fixture_store',history,[],null,[],null,kpi,'【確認済み期間】2026年6月',[{from:'2026-06-01',to:'2026-06-30'}],inputs,salesContext)
    assert.equal(requests.length,5)
    assert.equal(requests.slice(0,4).some(r=>JSON.stringify(r).includes('コード側で確定計算済み')),false)
    const final=JSON.stringify(requests.at(-1))
    if(salesContext) {
      for(const r of requests) {assert.match(JSON.stringify(r),/2025-12-09/);assert.match(JSON.stringify(r),/クロワッサン/);assert.match(JSON.stringify(r),/hourly_quantity/)}
      for(const r of requests.slice(0,4)) {
        assert.match(JSON.stringify(r),/重ね聞き/)
        assert.match(JSON.stringify(r),/前回の回答（本文）/)
        assert.match(JSON.stringify(r),/既存の軽食実績を先に見ます/)
      }
      assert.match(final,/前回の分析への質問/)
      assert.match(final,/前回の回答（本文・最優先で読む）/)
      assert.match(final,/裏付け用の今回集計/)
      assert.doesNotMatch(final,/最後に必ず、実行すべき次の一手/)
      assert.match(loopArgs.numberAuditFacts,/クロワッサン/)
      const compact=loop.compactFoodCourtEvaluationContext(loopArgs.evaluationContext+'long'.repeat(10000),14000,loopArgs.evaluationProtectedPrefixLength)
      assert.match(compact,/2025-12-09/);assert.match(compact,/クロワッサン/);assert.match(compact,/hourly_quantity/)
      assert.doesNotMatch(final,/以下の売上・客数は「テナント一覧/)
    }
    for (const prompt of [final]) {
      assert.match(prompt,/KGI・KPI・KFI/)
      assert.match(prompt,/KFI＝現場で実行・管理する行動指標/)
      assert.match(prompt,/記録方法・単位/)
      assert.match(prompt,/目標が無ければギャップ\/達成率を創作しない/)
      assert.match(prompt,/採算は未判定/)
      assert.match(prompt,/改善策が必要な場合にだけKPIへ落とし込む/)
      assert.match(prompt,/売上構成比のABC/)
      assert.doesNotMatch(prompt,/分析結果には必ず「KGI・KPI・KFI」/)
    }
    if(mode!=='journal') assert.match(final,/最後に必ず、実行すべき次の一手/)
    assert.equal(final.includes('コード側で確定計算済み'),enabled)
    assert.match(final,/確認済み期間/)
    assert.match(final,/指定範囲別のコード集計/)
    if(mode!=='empty') assert.match(final,/合計¥300,000/,'range aggregate includes days outside the 45-day detail window')
    assert.equal(loopArgs.numberAuditFacts.includes('コード側で確定計算済み'),enabled)
    assert.equal(loopArgs.evaluationContext.includes('保守／標準／強気'),enabled)
    if (enabled) {
      const compact = loop.compactFoodCourtEvaluationContext(loopArgs.evaluationContext + 'synthetic-long-facts'.repeat(2000), 14000, loopArgs.evaluationProtectedPrefixLength)
      assert.ok(compact.includes(kpi!.block), '評価用の省略でも3シナリオ全体を保持する')
      assert.ok(compact.length <= 14000)
      await ctx.evaluateFoodCourtAnswer({surface:'ask',question:input.question,contextBlock:loopArgs.evaluationContext + 'synthetic-long-facts'.repeat(2000),protectedPrefixLength:loopArgs.evaluationProtectedPrefixLength,finalAnswer:'synthetic',groqApiKey:'synthetic',primary:'synthetic',fallbackModel:'synthetic',config:{evaluatorMaxTokens:500,evaluatorProvider:'groq'}})
      assert.ok(requests.at(-1).messages[1].content.includes(kpi!.block), '実際の評価呼出しにも確定計算ブロックを保持する')
      requests.pop()
    }
    assert.equal(requests.at(-1).tokens,enabled?4200:1800)
    if(inputs) {
      for(const text of [final,loopArgs.numberAuditFacts,loopArgs.evaluationContext]) {assert.match(text,/833円/);assert.match(text,/123円/);assert.match(text,/仮定\(入力\)/)}
      assert.equal(requests.slice(0,4).some(r=>JSON.stringify(r).includes('今回の入力前提')),false)
      assert.match(final,/未入力.*未知のまま/)
    }
    if(mode==='ordinary') {
      const before=requests.length
      await ctx.answerFoodCourtQuestion(reports,'MARUGO S','売上の傾向を教えて','synthetic',[],[],undefined,'fixture_store',[],[],null,[],null,null,'【確認済み期間】2026年6月',[{from:'2026-06-01',to:'2026-06-30'}],null,null,['mix'])
      const methodPrompt=JSON.stringify(requests.slice(before))
      assert.match(methodPrompt,/今回選ばれた分析方法・最優先/)
      assert.match(methodPrompt,/売上構成・主力商品/)
      assert.doesNotMatch(methodPrompt,/目標・損益分岐・撤退: /)
    }
  }
})

test('follow-up detection treats later questions as about the previous answer unless the user starts over',()=>{
  const source=readFileSync(new URL('../supabase/functions/_shared/foodcourt_compare.ts',import.meta.url),'utf8')
  const executable=stripTypeScriptTypes(source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm,'').replace(/^export /gm,''))
    + '\nthis.isFoodCourtQaFollowUp=isFoodCourtQaFollowUp;this.latestFoodCourtAssistantAnswer=latestFoodCourtAssistantAnswer'
  const ctx=vm.createContext({...reliability,...loop,...groq,FOODCOURT_KPI_POLICY,FOODCOURT_SALES_POLICY,BUSINESS_GOAL_METRICS_POLICY,console,URL,URLSearchParams,setTimeout,clearTimeout,Deno:{env:{get:()=>''}}})
  vm.runInContext(executable,ctx)
  const history=[{role:'user',content:'売上を分析して'},{role:'assistant',content:'客数が伸び、客単価は横ばいです。'}]
  assert.equal(ctx.isFoodCourtQaFollowUp('客数のところをもっと詳しく',history),true)
  assert.equal(ctx.isFoodCourtQaFollowUp('同時購入は？',history),true)
  assert.equal(ctx.isFoodCourtQaFollowUp('最初から分析し直して',history),false)
  assert.equal(ctx.isFoodCourtQaFollowUp('売上を分析して',[]),false)
  assert.equal(ctx.latestFoodCourtAssistantAnswer(history),'客数が伸び、客単価は横ばいです。')
})

test('KGI input shows the gap against actual daily sales and does not invent a hit rate without a goal',async()=>{
  const storeGoal=await prepareFoodCourtKpiScenario({...input,assumptions:{unitPriceYen:420,unitCostYen:126,kgiTargetYen:200000,kgiHorizon:'day',kgiKind:'store'}},loaders())
  assert.match(storeGoal!.userAppendix,/KGI【仮定\(入力\)】店舗1日売上/)
  assert.match(storeGoal!.userAppendix,/¥200,000/)
  assert.match(storeGoal!.userAppendix,/ギャップ/)
  const upliftGoal=await prepareFoodCourtKpiScenario({...input,assumptions:{unitPriceYen:420,unitCostYen:126,kgiTargetYen:10000,kgiHorizon:'day',kgiKind:'uplift'}},loaders())
  assert.match(upliftGoal!.userAppendix,/純増目標/)
  assert.match(upliftGoal!.userAppendix,/店舗1日売上/)
  assert.doesNotMatch(upliftGoal!.userAppendix,/ギャップ ¥-/)
  assert.match(upliftGoal!.userAppendix,/施策売上≠純増/)
  const noGoal=await prepareFoodCourtKpiScenario({...input,assumptions:{unitPriceYen:420}},loaders())
  assert.match(noGoal!.userAppendix,/KGIは未設定/)
})

test('journal similar-item unit price is not copied as the new product selling price',async()=>{
  const io=loaders({missing:true})
  const journalDetail=await buildFoodCourtJournalDetail(
    [{from:'2025-12-09',to:'2025-12-09'}],
    'クロワッサン',
    async()=>[{business_date:'2025-12-09',gross_sales:1076,receipts:[{total:1076,time:'11:30',items:[{code:'1001',name:'クロワッサンサンド',qty:1,unit:1076,amount:1076}]}]}],
  )
  const result=await prepareFoodCourtKpiScenario({...input,salesDates:[],journalDetail},io)
  assert.ok(result)
  const tableRows=(result.userAppendix.split('シナリオ別KGI・KPI・採算の一覧')[1]||'').split('\n').filter(line=>line.startsWith('|'))
  const priceRow=tableRows.find(line=>line.includes('予想売価'))||''
  assert.doesNotMatch(priceRow,/1,076|1076/)
  assert.match(result.userAppendix,/売価・原価は入力または仮定\(シナリオ\)/)
  assert.match(result.userAppendix,/KGIは未設定/)
})

test('journal similar-item quantity is capped at the store\'s baking capacity, not sold as-is',async()=>{
  const io=loaders()
  // A single day where one existing product (unrelated to the new item) sold 500 units.
  // stored.bakeBatchUnits=20 x bakeBatchesPerDay=3 applies to all 3 scenarios, so capacity is
  // 60/day before waste — far below 500, so the outlook anchor must never reach the table or
  // the uplift as-is.
  const journalDetail=await buildFoodCourtJournalDetail(
    [{from:'2025-12-09',to:'2025-12-09'}],
    'クロワッサン',
    async()=>[{business_date:'2025-12-09',gross_sales:50000,receipts:[{total:50000,time:'11:30',items:[{code:'9001',name:'カレー2種',qty:500,unit:100,amount:50000}]}]}],
  )
  const result=await prepareFoodCourtKpiScenario({...input,salesDates:[],journalDetail},io)
  assert.ok(result)
  assert.match(result.userAppendix,/観測500個/)
  assert.match(result.userAppendix,/焼成上限×廃棄控除を上回ったため、販売数見込みはその上限に丸めた/)
  const tableRows=(result.userAppendix.split('シナリオ別KGI・KPI・採算の一覧')[1]||'').split('\n').filter(line=>line.startsWith('|'))
  const unitsRow=tableRows.find(line=>line.includes('予想販売数/日'))!
  const unitsCells=unitsRow.split('|').map(c=>c.trim()).filter(Boolean).slice(1)
  for (const cell of unitsCells) {
    const value=Number(cell.replace(/[^0-9.]/g,''))
    assert.ok(value<=60,`予想販売数/日 (${cell}) must not exceed the 60 units/day baking capacity`)
  }
  const upliftScenarios=result.reference.initiative_uplift!.scenarios
  for (const scenario of upliftScenarios) {
    assert.ok(scenario.daily_units!<=60,`uplift daily_units (${scenario.daily_units}) for ${scenario.label} must not exceed capacity`)
  }
  const hourlyTargets=result.reference.hourly_targets as Array<{daily_target_units:number|null}>
  for (const target of hourlyTargets) {
    assert.ok((target.daily_target_units??0)<=60,'hourly allocation daily target must not exceed capacity')
  }
})

test('set-inclusive (drink/wine upsell) sales are shown alongside single-item sales, with the mix assumptions disclosed',async()=>{
  const io=loaders()
  const result=await prepareFoodCourtKpiScenario({...input,assumptions:{unitPriceYen:420,unitCostYen:126,kgiTargetYen:10000,kgiHorizon:'day',kgiKind:'uplift'}},io)
  assert.ok(result)
  const appendix=result.userAppendix
  // The reasoning annotation must explain the basis before the table, not inside a cell.
  assert.match(appendix,/【セット込み予想売上の考え方・注釈】/)
  assert.match(appendix,/実測のドリンク・ワイン同時購入率ではない/)
  assert.match(appendix,/標準: 単品比率70%／ドリンクセット比率18%（単品\+¥350＝セット価格¥770）／ワインセット比率12%（単品\+¥700＝セット価格¥1,120）→ 加重平均売価¥567/)
  // Both the single-item-only KGI gap and the set-inclusive KGI gap are shown, distinctly labelled.
  assert.match(appendix,/純増ギャップ（標準シナリオ・単品のみ）/)
  assert.match(appendix,/純増ギャップ（標準シナリオ・セット込み）/)
  const tableRows=(appendix.split('シナリオ別KGI・KPI・採算の一覧')[1]||'').split('\n').filter(line=>line.startsWith('|'))
  const cells=(label:string)=>{
    const row=tableRows.find(line=>line.includes(label))
    assert.ok(row,`missing row: ${label}`)
    return row!.split('|').map(c=>c.trim()).filter(Boolean).slice(1).map(c=>Number(c.replace(/[^0-9.-]/g,'')))
  }
  const single=cells('予想売上/日（単品のみ）')
  const withSets=cells('予想売上/日（セット込み）')
  const upsell=cells('セットによる上乗せ額/日')
  for (let i=0;i<3;i++) {
    assert.ok(withSets[i]>single[i],'set-inclusive sales must exceed single-item sales once sets carry a price premium')
    assert.equal(upsell[i],withSets[i]-single[i])
  }
  // The single-item figure stays exactly what it was before this feature existed (no regression).
  // units: 8/12/18 per day; blended (set-inclusive) price: ¥498/¥567/¥660.
  assert.deepEqual(single,[3360,5040,7560])
  assert.deepEqual(withSets,[3984,6804,11880])
  // Set-inclusive uplift/contribution rows exist alongside the single-item ones, not replacing them.
  const upliftSingle=cells('上積み/日（単品のみ）')
  const upliftSets=cells('上積み/日（セット込み）')
  for (let i=0;i<3;i++) assert.ok(upliftSets[i]>upliftSingle[i])
  // Labels never leave the caveat unclear: the AI-facing block also distinguishes the two bases.
  assert.match(result.block,/単品価格のみ（ドリンク・ワインのセット上乗せなし）/)
  assert.match(result.block,/セット込み（ドリンクセット・ワインセットの上乗せを加重平均/)
  assert.ok(result.reference.initiative_uplift)
  assert.ok((result.reference as any).initiative_uplift_with_sets)
  assert.notEqual(
    (result.reference as any).initiative_uplift_with_sets.scenarios[1].initiative_daily_sales_yen,
    result.reference.initiative_uplift!.scenarios[1].initiative_daily_sales_yen,
  )
})

test('new-item plausibility check compares the scenario estimate against the store\'s own best-selling item',async()=>{
  const io=loaders()
  // One product ("カレー2種") sold 20 units on the single verified day: the outlook anchor and the
  // "top existing item" reference point are the same number on purpose, so the standard scenario's
  // clamped estimate (20, unrounded) lands exactly at parity with the existing bestseller (ratio 1.0)
  // and must trip the over-estimate flag; aggressive (30) trips it further, conservative (13.33) does not.
  const journalDetail=await buildFoodCourtJournalDetail(
    [{from:'2025-12-09',to:'2025-12-09'}],
    'クロワッサン',
    async()=>[{business_date:'2025-12-09',gross_sales:2000,receipts:[{total:2000,time:'11:30',items:[{code:'9001',name:'カレー2種',qty:20,unit:100,amount:2000}]}]}],
  )
  const result=await prepareFoodCourtKpiScenario({...input,salesDates:[],journalDetail},io)
  assert.ok(result)
  const check=(result.reference as any).new_item_plausibility
  assert.ok(check,'plausibility check must be present when journalDetail has sellable products')
  assert.equal(check.top_existing_item_name,'カレー2種')
  assert.equal(check.top_existing_item_daily_units,20)
  assert.equal(check.overestimate_flagged,true)
  const standard=check.scenarios.find((s:any)=>s.label==='標準')
  assert.equal(standard.daily_units,20)
  assert.equal(standard.ratio_to_top_existing_item,1)
  const conservative=check.scenarios.find((s:any)=>s.label==='保守')
  assert.ok(conservative.ratio_to_top_existing_item<1)
  // The plausibility block is exposed separately so foodcourt_compare.ts can hand it to the critic
  // AI without also handing over the full deterministic KPI table.
  assert.match(result.plausibilityBlock!,/前提の妥当性チェック/)
  assert.match(result.plausibilityBlock!,/カレー2種/)
  assert.match(result.plausibilityBlock!,/過大評価の可能性がある/)
  assert.doesNotMatch(result.plausibilityBlock!,/コード側で確定計算済み/)
  // ...and it reaches both the AI-facing block and the user-facing appendix.
  assert.match(result.block,/前提の妥当性チェック/)
  assert.match(result.userAppendix,/前提の妥当性チェック（当店の実測比較・業界目安ではない）/)
  assert.match(result.userAppendix,/過大評価の可能性がある/)
})

test('new-item plausibility check stays silent without journal product detail',async()=>{
  const result=await prepareFoodCourtKpiScenario({...input,assumptions:{unitPriceYen:420}},loaders())
  assert.ok(result)
  assert.equal(result.reference.new_item_plausibility,null)
  assert.equal(result.plausibilityBlock,'')
  assert.doesNotMatch(result.userAppendix,/前提の妥当性チェック/)
})

test('the critic AI receives the plausibility comparison but not the full KPI table',async()=>{
  const source=readFileSync(new URL('../supabase/functions/_shared/foodcourt_compare.ts',import.meta.url),'utf8')
  const executable=stripTypeScriptTypes(source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm,'').replace(/^export /gm,''))
  const requests: any[]=[]
  const ctx=vm.createContext({...reliability,...loop,...groq,FOODCOURT_KPI_POLICY,FOODCOURT_SALES_POLICY,BUSINESS_GOAL_METRICS_POLICY,foodCourtAnalysisMethodPrompt,console,URL,URLSearchParams,setTimeout,clearTimeout,
    Deno:{env:{get:()=>''}},classifyJournalChatIntent:()=>'data',
    captureChat:async(messages:any[],_key:string,_model:string,tokens:number)=>{requests.push({messages,tokens});return {content:'synthetic answer',usage:null}},
    captureLoop:async(args:any)=>{const result=await args.initialGenerate();return {answer:result.content,usages:[],loopScore:null,loopCount:1}},
  })
  vm.runInContext(executable,ctx)
  vm.runInContext(`foodCourtAiChat=captureChat;runFoodCourtLoopEngineering=captureLoop;buildForecastFactorsContext=async()=>'';loadFoodCourtLearningMemory=async()=>'';fetchFoodCourtXTrendBrief=async()=>null;recordFoodCourtAiUsage=async()=>{};`,ctx)
  const journalDetail=await buildFoodCourtJournalDetail(
    [{from:'2025-12-09',to:'2025-12-09'}],'クロワッサン',
    async()=>[{business_date:'2025-12-09',gross_sales:2000,receipts:[{total:2000,time:'11:30',items:[{code:'9001',name:'カレー2種',qty:20,unit:100,amount:2000}]}]}],
  )
  const kpi=await prepareFoodCourtKpiScenario({...input,journalDetail},loaders())
  assert.match(kpi!.plausibilityBlock!,/前提の妥当性チェック/)
  await ctx.answerFoodCourtQuestion([],'MARUGO S',input.question,'synthetic',[],[],undefined,'fixture_store',[],[],null,[],null,kpi)
  assert.equal(requests.length,5)
  // The critic is request index 3 (specialists 0-2 run in parallel first, critic runs after them,
  // the integrator runs last): it must see the short plausibility comparison so it can flag an
  // over/under-estimated scenario, but never the full deterministic KPI table (that stays the
  // integrator/final answer's job).
  const criticRequest=JSON.stringify(requests[3])
  assert.match(criticRequest,/前提の妥当性チェック/)
  assert.match(criticRequest,/カレー2種/)
  assert.doesNotMatch(criticRequest,/コード側で確定計算済み/)
  const final=JSON.stringify(requests.at(-1))
  assert.match(final,/前提の妥当性チェック/)
  assert.match(final,/コード側で確定計算済み/)
})

test('input context is numeric allowlist only; zero cost is preserved and no defaults are invented',()=>{
  assert.equal(buildFoodCourtKpiInputs({notes:'untrusted',unitPriceYen:'<script>',unitCostYen:null}),null)
  const context=buildFoodCourtKpiInputs({unitPriceYen:833,unitCostYen:0,store_key:'other',requested:true,notes:'UNTRUSTED'})!
  assert.equal(context.reference.items.length,2)
  assert.match(context.summary,/0円/);assert.match(context.summary,/833円/)
  assert.doesNotMatch(context.block,/UNTRUSTED|other|保守/)
})
