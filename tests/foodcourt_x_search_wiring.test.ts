import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const sourcePath = fileURLToPath(new URL('../supabase/functions/_shared/foodcourt_compare.ts', import.meta.url))
const source = readFileSync(sourcePath, 'utf8')

const journalPath = fileURLToPath(new URL('../supabase/functions/_shared/journal_ai_orchestrate.ts', import.meta.url))
const journalSource = readFileSync(journalPath, 'utf8')

// 背景: 専門AI③(Grok)は /v1/chat/completions 経由で呼ばれており、この経路は関数ツールしか
// 受け付けないため x_search が使えない = Xを一切検索していなかった。実際にXを検索できるのは
// Responses API + x_search だけなので、その経路をフードコート分析にも通す。

test('X search goes through the Responses API, never chat completions', () => {
  // 検索経路は Responses API のみ。フードコート側は journal の実装を再利用する。
  assert.match(journalSource, /https:\/\/api\.x\.ai\/v1\/responses/)
  assert.match(journalSource, /type:\s*"x_search"/)
  assert.match(source, /import \{ callGrokTrendBrief \} from '\.\/journal_ai_orchestrate\.ts'/)

  // 専門AI③ 本体は従来どおり chat/completions のまま（検索はしない役割分担）。
  const chatCompletions = source.match(/https:\/\/api\.x\.ai\/v1\/chat\/completions/g) ?? []
  assert.equal(chatCompletions.length, 1)
  // chat/completions に x_search ツールを宣言しても xAI 側で無視される（関数ツールのみ対応）。
  // 「足したから検索している」という誤解を生むので、この経路にツール宣言を書かない。
  assert.doesNotMatch(source, /type:\s*['"]x_search['"]/)
  assert.doesNotMatch(source, /tools:\s*\[/)
})

test('all four analysis surfaces fetch and inject the X trend brief', () => {
  // 定義1 + 4サーフェスからの呼び出し。
  const calls = source.match(/fetchFoodCourtXTrendBrief\(/g) ?? []
  assert.equal(calls.length, 5)

  // 専門AI3本と同じ Promise.all に入れて並列化する（分析の待ち時間を増やさない）。
  const parallel = source.match(/const \[quantRes, extRes, opsRes, xTrendBrief\] = await Promise\.all\(\[/g) ?? []
  assert.equal(parallel.length, 4)

  const blocks = source.match(/const xTrendBlock = formatFoodCourtXTrendBlock\(xTrendBrief\)/g) ?? []
  assert.equal(blocks.length, 4)

  // 4つの統合AIコンテキストすべてに注入されている。
  const injected = source.match(/\$\{xTrendBlock \? '\\n\\n' \+ xTrendBlock : ''\}/g) ?? []
  assert.equal(injected.length, 4)
})

test('every integrator is told how to use (and not use) the X trend block', () => {
  const rules = source.match(/【X最新トレンドの扱い】/g) ?? []
  assert.equal(rules.length, 4)
  // 売上の根拠に使わせない・出所を書かせる・無い時は言及させない、の3点を必ず含む。
  assert.match(source, /売上・客数の根拠に使ってはならず/)
  assert.match(source, /ブロックが無い場合はトレンドに言及しないこと/)
})

test('the brief has no substitute provider and degrades to silence', () => {
  // 他モデルはXを検索できないため、フォールバックを立てると「検索していないトレンド」が混ざる。
  // 取得できなければ null を返し、ブロックごとプロンプトから落とす。
  assert.match(source, /function formatFoodCourtXTrendBlock\([\s\S]{0,120}if \(!brief\) return ''/)
  assert.match(source, /if \(!resolveFoodCourtGrokApiKey\(\)\) return null/)
})

test('brief is cost-bounded by an on/off switch, a cache and a soft timeout', () => {
  assert.match(source, /FOODCOURT_X_SEARCH_ENABLED/)
  assert.match(source, /FOODCOURT_X_SEARCH_CACHE_TTL_MS/)
  assert.match(source, /FOODCOURT_X_SEARCH_SOFT_TIMEOUT_MS/)

  // 失敗結果を成功と同じだけ保持すると、一時障害で半日ブラインドになる。
  assert.match(source, /const ngTtlMs = Math\.min\(okTtlMs, 10 \* 60_000\)/)

  // ソフトタイムアウトは全体の締切の半分まで（統合AI・反証AIの取り分を残す）。
  assert.match(source, /Math\.min\(cap, Math\.floor\(remaining \/ 2\)\)/)
})

test('scheduled summaries share one cached search per day', () => {
  // 日次/期間/週次は質問文が無いので固定トピック = 全店舗で同じキャッシュキーになる。
  const scheduled = source.match(/FOODCOURT_X_TREND_SCHEDULED_TOPIC/g) ?? []
  assert.equal(scheduled.length, 4) // 定義1 + 3サーフェス
  // Q&A(ask) だけは質問文で検索して的を絞る。
  assert.match(source, /fetchFoodCourtXTrendBrief\(q, foodCourtXTrendSoftTimeoutMs\(deadlineAt\)\)/)
  assert.match(source, /foodCourtJstDate\(\)/)
})
