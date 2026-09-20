import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {isKpiScenarioRequest} from '../supabase/functions/_shared/kpi_scenario.ts';
const ctx=vm.createContext({Date});
vm.runInContext(readFileSync(new URL('../public/foodcourt-qa-planner.js',import.meta.url),'utf8'),ctx);
const planner=ctx.FOODCOURT_QA_PLANNER;
const plain=value=>JSON.parse(JSON.stringify(value));
const options={now:new Date('2026-09-20T08:00:00Z'),viewingDate:'2026-09-18'};

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
  assert.equal(result.kind,'ready');assert.equal(result.question,'売上の傾向を教えて');
  result=planner.nextTurn(result.state,'もっと詳しく',options);
  assert.equal(result.kind,'ready');assert.equal(result.period.ranges[0].from,'2026-06-01');
  result=planner.nextTurn(result.state,'その日は何があった？',options);
  assert.equal(result.period.ranges[0].from,'2026-06-01','follow-up must not switch to the unrelated viewing day');
  result=planner.nextTurn(result.state,'7月はどう？',options);
  assert.equal(result.period.ranges[0].from,'2026-07-01');
  result=planner.nextTurn(result.state,'直近3ヶ月は？',options);
  assert.equal(result.kind,'clarify','unrecognized periods must not silently reuse July');
  result=planner.nextTurn(result.state,'2026年6月',options);
  assert.equal(result.question,'直近3ヶ月は？');
  assert.equal(result.period.ranges[0].from,'2026-06-01');
});

test('KPI asks period then assumptions once; confirmation is not sent as a new question',()=>{
  let result=planner.nextTurn(planner.initialState(),'新商品のKPIを試算してください',options);
  result=planner.nextTurn(result.state,'全期間',options);
  assert.equal(result.state.pending.kind,'kpi');
  result=planner.nextTurn(result.state,'保存済み前提・仮置きで進む',options);
  assert.equal(result.kind,'ready');assert.equal(result.question,'新商品のKPIを試算してください');
  assert.equal(result.period.mode,'all');
  result=planner.nextTurn(result.state,'KPIを数字で',options);
  assert.equal(result.kind,'ready');
});

test('cancel, invalid/overlapping ranges and replacement questions do not start a wrong analysis',()=>{
  let result=planner.nextTurn(planner.initialState(),'売上を分析',options);
  result=planner.nextTurn(result.state,'2026-07-31〜2026-07-01',options);assert.equal(result.kind,'clarify');
  result=planner.nextTurn(result.state,'6月と6月',options);assert.equal(result.kind,'clarify');
  result=planner.nextTurn(result.state,'キャンセル',options);assert.equal(result.kind,'notice');assert.equal(result.state.pending,null);
  result=planner.nextTurn(result.state,'6月の客数を教えて',options);assert.equal(result.question,'6月の客数を教えて');
});

test('KPI planner matches server gate and explicit period means no period clarification',()=>{
  for(const q of ['粗利率とは？','先月の廃棄率は？','KPIを数字で','損益分岐の個数を教えて','新商品のKPIを試算してください','実績だけ','昨年のKPIを数字で教えて']) assert.equal(planner.wantsKpiTargets(q),isKpiScenarioRequest(q),q);
  const result=planner.nextTurn(planner.initialState(),'2026年6月の売上を教えて',options);assert.equal(result.kind,'ready');
});

test('croissant consultation with inputs asks trial consent without losing the original question',()=>{
  const question='売り上げアップのために、焼きたてのクロワッサンをお出ししようと思っています。どう思いますか？';
  const opts={...options,hasAssumptions:true,assumptionsReady:true};
  let result=planner.nextTurn(planner.initialState(),question,opts);
  assert.equal(result.state.pending.kind,'period');
  result=planner.nextTurn(result.state,'全期間',opts);
  assert.equal(result.state.pending.kind,'kpi_use');
  const analyze=planner.nextTurn(result.state,'入力値を使って分析のみ',opts);
  assert.equal(analyze.kind,'ready');assert.equal(analyze.question,question);
  assert.equal(isKpiScenarioRequest(analyze.question),false);
  const trial=planner.nextTurn(result.state,'入力値で3シナリオを試算',opts);
  assert.equal(trial.kind,'ready');assert.ok(trial.question.includes(question));
  assert.equal(isKpiScenarioRequest(trial.question),true);
  assert.equal(trial.period.mode,'all');
  const factual=planner.nextTurn(trial.state,'先月の実績だけ教えて',opts);
  assert.equal(factual.kind,'ready');assert.equal(isKpiScenarioRequest(factual.question),false);
  const cancelled=planner.nextTurn(result.state,'キャンセル',opts);
  assert.equal(cancelled.kind,'notice');assert.equal(cancelled.state.pending,null);
  const replacement=planner.nextTurn(result.state,'2026年6月の実績を教えて',opts);
  assert.equal(replacement.kind,'ready');assert.equal(replacement.period.ranges[0].from,'2026-06-01');
});
