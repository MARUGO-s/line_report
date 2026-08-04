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
  assert.match(source, /import \{ callGrokTrendBrief[^}]*\} from '\.\/journal_ai_orchestrate\.ts'/)

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
  const rules = source.match(/【X最新トレンドの扱い・使用は必須】/g) ?? []
  assert.equal(rules.length, 4)
  // 回帰防止(2026-08-04): 「使ってよい」と任意にしたら統合AIは一切使わなかった。
  // 捏造禁止ルールが並ぶ中で任意かつ注意書きだらけのブロックは、無視するのが合理的になる。
  // 使用を必須にしたうえでガードレールを課す、という形を崩さない。
  assert.doesNotMatch(source, /打ち手の着想には使ってよい/)
  const mandatory = source.match(/最低1つは、必ずそのトレンドを踏まえたものにすること/g) ?? []
  assert.equal(mandatory.length, 4)
  // メニュー・商品の方向性への反映が主目的なので、その用途を必ず示す。
  const menuUse = source.match(/メニューや商品の方向性/g) ?? []
  assert.equal(menuUse.length, 4)
  // 回帰防止(2026-08-04): 使用を必須にしただけでは「X上で話題の季節の食材」のような
  // 一般語への言い換えが起き、検索した意味が消える。具体名の引用を明示的に要求する。
  const verbatim = source.match(/一般語に言い換えてはならない/g) ?? []
  assert.equal(verbatim.length, 4)
  // ガードレール: 売上根拠への流用禁止・不在時は言及禁止。
  assert.match(source, /売上・客数の根拠には使わない/)
  assert.match(source, /ブロックが無い場合はトレンドに言及しないこと/)
})

test('the brief text is persisted so its quality can be judged directly', () => {
  // 統合AIが圧縮した後の answer しか残らないと、「Xの情報が薄い」のか
  // 「統合AIが潰した」のかを切り分けられない。
  assert.match(source, /xTrendBrief: xTrendBrief \? xTrendBrief\.text : null/)
  const apiPath = fileURLToPath(new URL('../supabase/functions/admin-api/index.ts', import.meta.url))
  const api = readFileSync(apiPath, 'utf8')
  assert.match(api, /x_trend_brief: qaResult\.xTrendBrief \?\? null/)
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

test('the user question is never used as the X search query', () => {
  // 回帰防止(2026-08-04): Q&Aだけ質問文を検索クエリに渡していたが、このシステムへの質問は
  // 「売上を伸ばすための提案を3つ」のように自店の数字の話で、Xには存在しない。
  // 実際に無関係な投稿を31,728トークン取り込んで課金だけ発生し、引用が成立せず破棄された。
  assert.doesNotMatch(source, /fetchFoodCourtXTrendBrief\(\s*q\s*,/)

  // 4サーフェスとも同じ固定トピックを使う = 同じキャッシュキー = 1日1検索。
  const calls = source.match(/fetchFoodCourtXTrendBrief\(foodCourtXTrendTopic\(\),/g) ?? []
  assert.equal(calls.length, 4)
  assert.match(source, /foodCourtJstDate\(\)/)
})

test('the X search looks at food trends broadly, not just the venue', () => {
  // 東京ドーム周辺に絞ると投稿数が足りず話題が痩せる。会場のイベント・客層は
  // 専門AI②が tokyo_dome_events から取っているので、Xで補う必要がない。
  // Xにしか無いのは「いま何が食べられ、どう見せられ、どう語られているか」。
  assert.match(source, /東京中心。話題が薄ければ全国まで広げてよい/)
  assert.match(source, /スパイスカレー・カレー全般の流行/)
  assert.match(source, /ワインの飲まれ方/)
  // デプロイせずに検索対象を調整できること。
  assert.match(source, /FOODCOURT_X_SEARCH_TOPIC/)
})

test('reasoning tokens cannot starve the brief text', () => {
  // grok-4.5 は reasoning も output に算入される。1400では推論で枠を使い切って
  // 本文が出ず empty_content になりうる（実測 1339/1400）。
  assert.doesNotMatch(journalSource, /max_output_tokens:\s*1400/)
  assert.match(journalSource, /GROK_X_SEARCH_MAX_OUTPUT_TOKENS/)
  // env読み取りは呼び出し側に置く。組み立て関数を純粋に保たないと
  // --allow-env なしのテストから呼べなくなる。
  assert.match(journalSource, /max_output_tokens: maxOutputTokens/)
})

test('dropped briefs are recorded with their reason', () => {
  // 検索は走った＝課金済みなのに使われなかったケースを後から数えられるようにする。
  assert.match(source, /const dropTag = dropReason \? ` drop:\$\{String\(dropReason\)\.slice\(0, 40\)\}` : ''/)
  assert.match(source, /recordFoodCourtXTrendUsage\(supabase, storeKey, brief\.usage, result \? null : \(brief\.error \?\? 'unknown'\)\)/)
})

test('brief cost is recorded so the estimate can be checked against reality', () => {
  // x_search はトークンとは別に $5/1k calls で課金される。トークンだけ記録しても実費は出ない。
  assert.match(journalSource, /xSearchCalls/)
  assert.match(journalSource, /function extractGrokUsage\(/)

  // 破棄した応答(x_search_not_used / missing_x_citations)でも xAI は課金済みなので usage を返す。
  const usageReturns = journalSource.match(/usage: extractGrokUsage\(json, model, parsed\.xSearchCalls\)/g) ?? []
  assert.equal(usageReturns.length, 3) // 成功 + 破棄2種

  // ツール回数の列が無いため model 名に残し、SQLで復元できるようにする。
  assert.match(source, /model: `\$\{usage\.model\} x_search\*\$\{usage\.xSearchCalls\}\$\{dropTag\}`/)
  assert.match(source, /await recordFoodCourtXTrendUsage\(supabase, storeKey, brief\.usage,/)
})

test('x_search tokens are not priced at the cheap grok-3-mini rate', () => {
  const usagePagePath = fileURLToPath(new URL('../public/ai-usage.html', import.meta.url))
  const page = readFileSync(usagePagePath, 'utf8')
  // 同じ provider=grok でも単価が桁違い。model 名で単価を切り替えないと実費を過小表示する。
  assert.match(page, /grok_xsearch:\s*\{\s*inUsd:\s*2\.00,\s*outUsd:\s*6\.00\s*\}/)
  assert.match(page, /x_search\/i\.test\(String\(model \|\| ''\)\) \? 'grok_xsearch' : 'grok'/)
  // ツール実行料はトークン計算に載らないので、画面上で明示する。
  assert.match(page, /\$5 \/ 1,000回/)
})
