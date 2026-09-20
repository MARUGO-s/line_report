import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { BUSINESS_GOAL_METRICS_POLICY } from '../supabase/functions/_shared/business_goal_metrics.ts'
import { FOODCOURT_KPI_POLICY } from '../supabase/functions/_shared/foodcourt_kpi.ts'
import * as reliability from '../supabase/functions/_shared/foodcourt_ai_reliability.ts'
import * as loop from '../supabase/functions/_shared/foodcourt_loop_utils.ts'
import * as groq from '../supabase/functions/_shared/groq_model.ts'
import * as attendance from '../supabase/functions/_shared/foodcourt_attendance.ts'

test('framework uses the requested action meaning and forbids benchmark/denominator substitutions', () => {
  const policy = BUSINESS_GOAL_METRICS_POLICY
  for (const text of ['KFI＝現場で実行・管理する行動指標', '担当候補', '実施タイミング', '記録方法・単位',
    'KGIの目標との差→要因KPI→改善するKFI', 'KFIの実行→KPIの変化→KGIへの寄与',
    '予約・会員・再来店が未導入/未計測', 'フードコートの共有席', '二重計上', '歩留まり率',
    'FLRコスト率', '合意済み目標へ転用しない', '行動件数を計算・創作しない', '同じ表・同じ合計に混ぜない']) {
    assert.ok(policy.includes(text), text)
  }
  assert.doesNotMatch(policy, /55|60|62|15,000|30%|50%/)
})

test('daily, period and weekly production paths send the same framework to integration and evaluation without breaking fixed headings', async () => {
  const source = readFileSync(new URL('../supabase/functions/_shared/foodcourt_compare.ts', import.meta.url), 'utf8')
  const executable = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm, '').replace(/^export /gm, ''))
  const requests: any[] = [], evaluations: any[] = []
  const ctx = vm.createContext({ ...reliability, ...loop, ...groq, ...attendance, BUSINESS_GOAL_METRICS_POLICY, FOODCOURT_KPI_POLICY,
    console, URL, URLSearchParams, setTimeout, clearTimeout, Deno: { env: { get: () => '' } },
    captureChat: async (messages: any[]) => { requests.push(messages); return { content: 'synthetic analysis', usage: null } },
    captureLoop: async (args: any) => { evaluations.push(args); const generated = await args.initialGenerate(); return { answer: generated.content, usages: [], loopScore: null, loopCount: 1 } },
  })
  vm.runInContext(executable, ctx)
  vm.runInContext(`foodCourtAiChat=captureChat;runFoodCourtLoopEngineering=captureLoop;buildForecastFactorsContext=async()=>'';loadFoodCourtLearningMemory=async()=>'';fetchFoodCourtXTrendBrief=async()=>null;recordFoodCourtAiUsage=async()=>{};`, ctx)
  const reports = Array.from({ length: 7 }, (_, i) => ({ report_date: `2026-06-0${i + 2}`, tenants: [{ name: 'MARUGO S', sales: 10000, guests: 10 }, { name: 'Other', sales: 5000, guests: 5 }] })).reverse()
  assert.equal(await ctx.generateFoodCourtDailySummary(reports, 'MARUGO S', reports[0], 'synthetic'), 'synthetic analysis')
  assert.equal(await ctx.generateFoodCourtPeriodSummary(reports, 'MARUGO S', '2026-06-01', '2026-06-07', 'synthetic'), 'synthetic analysis')
  assert.equal((await ctx.generateFoodCourtWeeklyReport(reports, 'MARUGO S', '2026-06-01', '2026-06-07', 'synthetic')).report, 'synthetic analysis')
  assert.deepEqual(evaluations.map(e => e.surface), ['daily_summary', 'period_summary', 'weekly_report'])
  for (let i = 0; i < evaluations.length; i++) {
    assert.ok(!evaluations[i].evaluationContext.includes(BUSINESS_GOAL_METRICS_POLICY), 'instructions must not consume the truncated facts budget')
    const finalSystem = requests[i * 5 + 4][0].content
    assert.ok(finalSystem.includes(BUSINESS_GOAL_METRICS_POLICY))
    assert.match(finalSystem, /見出しを増やさず/)
    assert.match(finalSystem, i < 2 ? /次の7つの見出し/ : /次の5つの見出し/)
    assert.doesNotMatch(evaluations[i].numberAuditFacts, /KGI・KPI・KFI/, 'instructions are not numeric evidence')
  }
  assert.equal(ctx.resolveFoodCourtDailyAnalysisVersion(), 'foodcourt-analysis-ai-v21-goal-metrics')
  await ctx.evaluateFoodCourtAnswer({surface:'ask',question:'店舗売上の改善',contextBlock:'synthetic facts',finalAnswer:'synthetic analysis',groqApiKey:'synthetic',primary:'synthetic',fallbackModel:'synthetic',config:{evaluatorMaxTokens:500,evaluatorProvider:'groq'}})
  assert.ok(requests.at(-1)[0].content.includes(BUSINESS_GOAL_METRICS_POLICY))
  assert.match(requests.at(-1)[1].content, /synthetic facts/)
})
