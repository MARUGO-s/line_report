import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {isKpiScenarioRequest} from '../supabase/functions/_shared/kpi_scenario.ts';
import {FOODCOURT_ANALYSIS_METHODS} from '../supabase/functions/_shared/foodcourt_qa_methods.ts';
const ctx=vm.createContext({Date});
vm.runInContext(readFileSync(new URL('../public/foodcourt-qa-planner.js',import.meta.url),'utf8'),ctx);
const planner=ctx.FOODCOURT_QA_PLANNER;
const plain=value=>JSON.parse(JSON.stringify(value));
const options={now:new Date('2026-09-20T08:00:00Z'),viewingDate:'2026-09-18'};

test('browser method catalog ids match the server catalog',()=>{
  assert.deepEqual(plain(planner.ANALYSIS_METHODS.map(m=>m.id)), plain(FOODCOURT_ANALYSIS_METHODS.map(m=>m.id)));
  assert.deepEqual(plain(planner.ANALYSIS_METHODS.map(m=>m.label)), plain(FOODCOURT_ANALYSIS_METHODS.map(m=>m.label)));
});

test('period resolver supports exact dates, months, comparisons, relative months and default',()=>{
  for(const [text,ranges] of [
    ['2026年6月の分析',[{from:'2026-06-01',to:'2026-06-30'}]],
    ['6月の店舗全部を比較',[{from:'2026-06-01',to:'2026-06-30'}]],
    ['2026-06',[{from:'2026-06-01',to:'2026-06-30'}]],
    ['6月と8月を比較',[{from:'2026-06-01',to:'2026-06-30'},{from:'2026-08-01',to:'2026-08-31'}]],
    ['2026年6月から8月',[{from:'2026-06-01',to:'2026-08-31'}]],
    ['先月と今月を比較',[{from:'2026-08-01',to:'2026-08-31'},{from:'2026-09-01',to:'2026-09-20'}]],
    ['2026-06-01〜2026-06-15',[{from:'2026-06-01',to:'2026-06-15'}]],
    ['2026-06-01と2026-08-01を比較',[{from:'2026-06-01',to:'2026-06-01'},{from:'2026-08-01',to:'2026-08-01'}]],
    ['去年6月',[{from:'2025-06-01',to:'2025-06-30'}]],
    ['表示中の日',[{from:'2026-09-18',to:'2026-09-18'}]],
    ['おまかせ',[]],
  ]) assert.deepEqual(plain(planner.resolvePeriod(text,options.now,options.viewingDate).ranges),ranges,text);
  assert.equal(planner.resolvePeriod('2026-02-31',options.now).error.length>0,true);
  assert.equal(planner.resolvePeriod('13月',options.now).error.length>0,true);
  assert.ok(planner.resolvePeriod('6月1日〜6月15日',options.now).error);
  assert.ok(planner.resolvePeriod('2026年6月1日〜6月15日',options.now).error);
});

test('missing period asks once, clarification preserves question, follow-up retains or replaces scope',()=>{
  let result=planner.nextTurn(planner.initialState(),'売上の傾向を教えて',options);
  assert.equal(result.kind,'clarify');assert.equal(result.state.pending.kind,'period');
  result=planner.nextTurn(result.state,'2026年6月',options);
  assert.equal(result.state.pending.kind,'methods');
  result=planner.nextTurn(result.state,'おすすめ全部で進む',options);
  assert.equal(result.kind,'ready');assert.equal(result.question,'売上の傾向を教えて');
  assert.ok(result.methods.includes('mix'));
  result=planner.nextTurn(result.state,'もっと詳しく',options);
  assert.equal(result.kind,'ready');assert.equal(result.period.ranges[0].from,'2026-06-01');
  assert.deepEqual(result.methods,result.state.methods);
  result=planner.nextTurn(result.state,'その日は何があった？',options);
  assert.equal(result.period.ranges[0].from,'2026-06-01','follow-up must not switch to the unrelated viewing day');
  result=planner.nextTurn(result.state,'7月はどう？',options);
  assert.equal(result.period.ranges[0].from,'2026-07-01');
  result=planner.nextTurn(result.state,'直近3ヶ月は？',options);
  assert.equal(result.kind,'clarify','unrecognized periods must not silently reuse July');
  result=planner.nextTurn(result.state,'2026年6月',options);
  assert.equal(result.state.pending.kind,'methods');
  result=planner.nextTurn(result.state,'おすすめ全部で進む',options);
  assert.equal(result.question,'直近3ヶ月は？');
  assert.equal(result.period.ranges[0].from,'2026-06-01');
});

test('KPI asks period then methods, then sell-price and cost before analysis',()=>{
  let result=planner.nextTurn(planner.initialState(),'新商品のKPIを試算してください',options);
  result=planner.nextTurn(result.state,'全期間',options);
  assert.equal(result.state.pending.kind,'methods');
  assert.ok(result.state.pending.recommended.includes('kpi'));
  result=planner.nextTurn(result.state,'おすすめ全部で進む',options);
  assert.equal(result.kind,'clarify');
  assert.equal(result.state.pending.kind,'assumptions');
  assert.match(result.message,/想定売価/);
  assert.match(result.message,/最終目標KGI/);
  assert.ok(result.actions.includes('全部お任せ'));
  assert.ok(result.actions.includes('入力欄に書いて進む'));
  result=planner.nextTurn(result.state,'全部お任せ',options);
  assert.equal(result.kind,'ready');assert.equal(result.question,'新商品のKPIを試算してください');
  assert.equal(result.period.mode,'all');
  assert.equal(result.allowEstimate,true);
  assert.equal(result.state.kpiConfirmed,true);
  assert.ok(result.methods.includes('kpi'));
  result=planner.nextTurn(result.state,'KPIを数字で',options);
  assert.equal(result.kind,'ready');
});

test('cancel, invalid/overlapping ranges and replacement questions do not start a wrong analysis',()=>{
  let result=planner.nextTurn(planner.initialState(),'売上を分析',options);
  result=planner.nextTurn(result.state,'2026-07-31〜2026-07-01',options);assert.equal(result.kind,'clarify');
  result=planner.nextTurn(result.state,'6月と6月',options);assert.equal(result.kind,'clarify');
  result=planner.nextTurn(result.state,'キャンセル',options);assert.equal(result.kind,'notice');assert.equal(result.state.pending,null);
  result=planner.nextTurn(result.state,'6月の客数を教えて',options);
  assert.equal(result.state.pending.kind,'methods');
  result=planner.nextTurn(result.state,'おすすめ全部で進む',options);
  assert.equal(result.question,'6月の客数を教えて');
});

test('KPI planner matches server gate and explicit period means no period clarification',()=>{
  for(const q of ['粗利率とは？','先月の廃棄率は？','KPIを数字で','損益分岐の個数を教えて','新商品のKPIを試算してください','実績だけ','昨年のKPIを数字で教えて','売上を伸ばすための提案を3つ','KGI・KPI・KFIを含む改善提案','KPI目標の達成状況を確認して','提案した新商品の販売分析をお願い','販売分析をお願い','新しい施策の売上貢献を分析して','この施策で売上をどれだけ上積みできるか']) assert.equal(planner.wantsKpiTargets(q),isKpiScenarioRequest(q),q);
  assert.equal(planner.wantsKpiTargets('販売分析をお願い','クロワッサンの導入はどう思う？'),true);
  assert.equal(isKpiScenarioRequest('販売分析をお願い','クロワッサンの導入はどう思う？'),true);
  assert.equal(planner.wantsKpiTargets('KPI分析してみてください','クロワッサンの導入はどう思う？'),true);
  assert.equal(isKpiScenarioRequest('KPI分析してみてください','クロワッサンの導入はどう思う？'),true);
  let result=planner.nextTurn(planner.initialState(),'2026年6月の売上を教えて',options);
  assert.equal(result.state.pending.kind,'methods');
  result=planner.nextTurn(result.state,'おすすめ全部で進む',options);
  assert.equal(result.kind,'ready');
});

test('follow-up KPI analysis after croissant adds the kpi method instead of refusing estimates',()=>{
  const question='売り上げアップのために、焼きたてのクロワッサンをお出ししようと思っています。どう思いますか？';
  const hist=question+'\n軽食の実績を見ます。';
  const opts={...options,historyText:hist,hasPriorAnswer:true};
  let result=planner.nextTurn(planner.initialState(),question,options);
  result=planner.nextTurn(result.state,'全期間',options);
  result=planner.nextTurn(result.state,'この分析で進む',options);
  assert.equal(result.kind,'ready');
  assert.equal(result.methods.includes('kpi'),false);
  const follow=planner.nextTurn(result.state,'KPI分析してみてください',opts);
  assert.equal(follow.kind,'clarify');
  assert.equal(follow.state.pending.kind,'assumptions');
  const go=planner.nextTurn(follow.state,'全部お任せ',opts);
  assert.equal(go.kind,'ready');
  assert.equal(go.question,'KPI分析してみてください');
  assert.ok(go.methods.includes('kpi'));
  assert.equal(go.state.kpiConfirmed,true);
  assert.equal(go.allowEstimate,true);
});

test('croissant consultation with inputs asks trial consent without losing the original question',()=>{
  const question='売り上げアップのために、焼きたてのクロワッサンをお出ししようと思っています。どう思いますか？';
  const opts={...options,hasAssumptions:true,assumptionsReady:true,hasUnitPrice:true,hasUnitCost:true};
  let result=planner.nextTurn(planner.initialState(),question,opts);
  assert.equal(result.state.pending.kind,'period');
  result=planner.nextTurn(result.state,'全期間',opts);
  assert.equal(result.state.pending.kind,'methods');
  const analyze=planner.nextTurn(result.state,'この分析で進む',opts);
  assert.equal(analyze.kind,'ready');assert.equal(analyze.question,question);
  assert.equal(isKpiScenarioRequest(analyze.question),false);
  assert.equal(analyze.methods.includes('kpi'),false);
  const trial=planner.nextTurn(result.state,'入力値で3シナリオを試算',opts);
  assert.equal(trial.kind,'ready');assert.equal(trial.question,question);
  assert.ok(trial.methods.includes('kpi'));
  assert.equal(trial.state.kpiConfirmed,true);
  assert.equal(trial.period.mode,'all');
  const factual=planner.nextTurn(trial.state,'先月の実績だけ教えて',opts);
  assert.equal(factual.kind,'ready');assert.equal(isKpiScenarioRequest(factual.question),false);
  const cancelled=planner.nextTurn(result.state,'キャンセル',opts);
  assert.equal(cancelled.kind,'notice');assert.equal(cancelled.state.pending,null);
  const replacement=planner.nextTurn(result.state,'2026年6月の実績を教えて',opts);
  assert.equal(replacement.state.pending.kind,'methods');
  const readyReplacement=planner.nextTurn(replacement.state,'おすすめ全部で進む',opts);
  assert.equal(readyReplacement.kind,'ready');assert.equal(readyReplacement.period.ranges[0].from,'2026-06-01');
});

test('period chips used on the screen still stop at method selection',()=>{
  for(const chip of ['保存済み全期間','今月','先月']) {
    let result=planner.nextTurn(planner.initialState(),'売上の傾向を教えて',options);
    result=planner.nextTurn(result.state,chip,options);
    assert.equal(result.kind,'clarify',chip);
    assert.equal(result.state.pending.kind,'methods',chip);
    assert.equal(result.kind==='ready',false,chip);
  }
});

test('method chips accumulate, reveal extras, and margin/kpi allow estimates without cost',()=>{
  let result=planner.nextTurn(planner.initialState(),'売上の傾向を教えて',options);
  result=planner.nextTurn(result.state,'全期間',options);
  assert.match(result.message,/粗利が未登録でも/);
  assert.ok(result.choices.includes('売上構成・主力商品'));
  assert.equal(result.choices.includes('同時購入・併売'),false);
  assert.equal(result.choices.includes('おすすめ全部で進む'),false);
  assert.ok(result.actions.includes('おすすめ全部で進む'));
  assert.ok(result.actions.includes('この分析で進む'));
  result=planner.nextTurn(result.state,'売上構成・主力商品',options);
  assert.equal(result.state.pending.kind,'methods');
  assert.ok(result.choices.includes('✓ 売上構成・主力商品'));
  result=planner.nextTurn(result.state,'ほかの手法を見る',options);
  assert.ok(result.choices.includes('粗利・採算（未登録なら推測）'));
  result=planner.nextTurn(result.state,'粗利・採算（未登録なら推測）',options);
  result=planner.nextTurn(result.state,'この分析で進む',options);
  assert.equal(result.state.pending.kind,'assumptions');
  result=planner.nextTurn(result.state,'全部お任せ',options);
  assert.equal(result.kind,'ready');
  assert.deepEqual(plain(result.methods),['mix','margin']);
  assert.equal(result.state.kpiConfirmed,true);
});

test('entered price and cost skip the extra question; chat numbers are accepted',()=>{
  const filled={...options,hasUnitPrice:true,hasUnitCost:true};
  let result=planner.nextTurn(planner.initialState(),'新商品のKPIを試算してください',filled);
  result=planner.nextTurn(result.state,'全期間',filled);
  result=planner.nextTurn(result.state,'おすすめ全部で進む',filled);
  assert.equal(result.kind,'ready');
  assert.equal(result.allowEstimate,false);
  const parsed=planner.parsePriceCostFromText('売価420円、原価126円');
  assert.equal(parsed.unitPriceYen,420);
  assert.equal(parsed.unitCostYen,126);
  const kgi=planner.parsePriceCostFromText('月商50万円、売価400円');
  assert.equal(kgi.kgiTargetYen,500000);
  assert.equal(kgi.kgiHorizon,'month');
  const daily=planner.parsePriceCostFromText('KGIは1日2000円、原価100円');
  assert.equal(daily.kgiTargetYen,2000);
  assert.equal(daily.kgiHorizon,'day');
  let asking=planner.nextTurn(planner.initialState(),'新商品のKPIを試算してください',options);
  asking=planner.nextTurn(asking.state,'全期間',options);
  asking=planner.nextTurn(asking.state,'おすすめ全部で進む',options);
  const typed=planner.nextTurn(asking.state,'売価380円、原価110円',{...options,hasUnitPrice:true,hasUnitCost:true});
  assert.equal(typed.kind,'ready');
  assert.equal(typed.question,'新商品のKPIを試算してください');
  assert.equal(typed.period.mode,'all');
});
