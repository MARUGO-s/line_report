// 小口現金（出金/経費）の LINE 取込フロー（独立モジュール）。
// 「経費」と送る → 画像待ち → 出金レシート画像を送る → AIが本体/税を抽出 →
// 確認カード →「この内容で記録」で petty_cash_entries に記録。
// ※明示トリガー方式。売上レシート（通常送信）には一切干渉しない。
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import type { StoreRegistryRow } from './store_receipt.ts'
import type { LineImageReceiptAnalysis } from './receipt_types.ts'
import { replyLineMessages, resolveChannelAccessToken } from './line_client.ts'
import { issueAdminDashboardLoginLinkToken, PETTY_CASH_SCOPE } from './admin_dashboard_link_auth.ts'
import { fetchLineDisplayNameByUserId } from './line_display_names.ts'
import { looksLikeSalesSettlementReceipt } from './receipt_parse.ts'

const PENDING_TABLE = 'petty_cash_pending'
const ENTRIES_TABLE = 'petty_cash_entries'
const PENDING_TTL_MIN = 30
// 起動トリガー（完全一致のみ。部分一致で誤爆させない）。
const TRIGGER_WORDS = new Set(['経費', '経費登録', '出金', '出金登録', '小口', '小口登録', '小口現金'])
const CANCEL_WORDS = new Set(['キャンセル', '中止', 'やめる', 'やめ', 'cancel', 'Cancel'])
// レジ出金（＝経費の支払い）伝票のマーカー。これらを含む受領レシートは「売上」ではない。
const CASH_OUT_MARKERS = /レジ出金|出金伝票|今回出金額|出金額|現金出金|小口出金|出金処理/

// LINE完了カードから開く小口現金ページ。売上分析と同じ仕組み（from=line＋store_key＋ワンタイム lt）で
// 自動ログインし、その店舗のみ閲覧できるようにする。
const PETTY_CASH_PAGE_BASE = 'https://marugo-s.github.io/line_report/petty_cash.html'
const LINE_PETTY_URI_MAX_LEN = 1000

export type PettyCashTextResult = { handled: boolean; replied: boolean }
export type PettyCashImageResult = { handled: boolean; replied: boolean; saved?: boolean; reason?: string }

function conversationKey(roomId: string, userId: string | null): string {
  return `${roomId || '__unknown_room__'}::${userId || '__anonymous__'}`
}

function formatYen(n: number): string {
  return '¥' + Math.round(Math.max(0, n)).toLocaleString('en-US')
}

// "¥1,234" / "1234円" → 1234（数字のみ抽出）。読めなければ null。
function parseYenToInt(s: unknown): number | null {
  if (s == null) return null
  const digits = String(s).replace(/[^\d]/g, '')
  if (!digits) return null
  const n = Number(digits)
  return Number.isFinite(n) ? n : null
}

// 各種日付表記 → "YYYY-MM-DD"。読めなければ null。
function normalizeDateYmd(s: unknown): string | null {
  if (s == null) return null
  const t = String(s).trim()
  const m = t.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/)
  if (!m) return null
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function todayYmdJst(): string {
  const j = new Date(Date.now() + 9 * 3600 * 1000)
  return `${j.getUTCFullYear()}-${String(j.getUTCMonth() + 1).padStart(2, '0')}-${String(j.getUTCDate()).padStart(2, '0')}`
}

// 品目ごとの内訳（小口現金ページと同じモデル）。n:品目 p:税抜価格 acct:勘定科目 rate:税率(8|10)。
type PettyCashItem = { n: string; p: number; acct: 'shokuzai' | 'shomohin' | 'alcohol'; rate: 8 | 10 }
type PettyTaxMode = 'ex' | 'in'
// 品名から勘定科目を推定（既定。記録後に小口現金ページで修正可）。
//   アルコール飲料 → alcohol、消耗品/衛生用品 → shomohin、それ以外 → shokuzai(食材)。
//   ※「消毒用アルコール」等は飲料ではないので shomohin 側で先に拾う。
//   ※本みりん・味醂は酒税法上の酒類（軽減税率対象外・10%）。「みりん風調味料」「みりん干し」
//     「みりん漬け」は酒類ではない食品(8%)なので、みりん単体は後続文字（風/干/漬）で除外する。
const ALCOHOL_DRINK_RE = /(ビール|発泡酒|ワイン|シャンパン|スパークリング|日本酒|清酒|焼酎|ウイスキー|ウィスキー|ハイボール|サワー|酎ハイ|チューハイ|ジン|ウォッカ|ラム|テキーラ|リキュール|梅酒|ハウスワイン|生樽|樽生|地酒|スピリッツ|本みりん|本味醂|味醂(?![風干漬])|みりん(?![風干漬])|sake|beer|wine|whisky|whiskey|vodka|tequila)/i
const SHOMOHIN_RE = /(消耗品|日用品|雑貨|備品|事務用品|洗剤|消毒|除菌|アルコール消毒|ペーパー|タオル|ナフキン|ふきん|布巾|ラップ|アルミホイル|ホイル|手袋|ゴム手|ゴミ袋|ごみ袋|ポリ袋|レジ袋|レジブクロ|買物袋|買い物袋|マイバッグ|ショッピングバッグ|スポンジ|たわし|掃除|清掃|文具|電池|乾電池|単[0-9０-９一二三四五]|PRE単|富士通|アルカリ|マンガン|コバエ|小バエ|ハエ|虫取り|虫とり|防虫|殺虫|捕虫|虫よけ|虫除け|バルくん|割り箸|割箸|箸|ストロー|カップ|紙コップ|容器|包装|ラベル|マスク|衛生|トイレット|ティッシュ)/i
function classifyPettyAcct(name: string, opts?: { rate?: 8 | 10 | null; supplier?: string | null }): 'shokuzai' | 'shomohin' | 'alcohol' {
  const s = String(name ?? '')
  const supplier = String(opts?.supplier ?? '')
  if (/(seria|セリア)/i.test(`${supplier} ${s}`)) return 'shomohin'
  if (SHOMOHIN_RE.test(s)) return 'shomohin'
  if (ALCOHOL_DRINK_RE.test(s)) return 'alcohol'
  // 西友の領収証では「※」付きだけが食品(8%)で、※無しの10%行は消耗品または酒類。
  // 酒類は上で確定しているため、残りを食材扱いに戻さない。
  if (/(seiyu|西友)/i.test(supplier) && opts?.rate === 10) return 'shomohin'
  if (opts?.rate === 10 && /(10%対象|10％対象|日用品|雑貨|備品|文具|電池|単[0-9０-９一二三四五]|PRE単|富士通|コバエ|小バエ|ハエ|虫)/i.test(`${supplier} ${s}`)) return 'shomohin'
  return 'shokuzai'
}
function defaultPettyRate(acct: 'shokuzai' | 'shomohin' | 'alcohol'): 8 | 10 {
  return acct === 'shokuzai' ? 8 : 10
}
const PETTY_ACCT_JP: Record<string, string> = { shokuzai: '食材', shomohin: '消耗品', alcohol: 'アルコール' }
// 旧 category 列向けの科目ラベル（重複排除して「・」連結。例: 食材・消耗品）。
function pettyItemsLabel(items: PettyCashItem[] | null): string {
  if (!Array.isArray(items) || !items.length) return ''
  const names = [...new Set(items.map((it) => PETTY_ACCT_JP[it.acct] ?? '未分類'))]
  return names.join('・')
}

// レシート解析結果 → 経費フィールド（出金額/税/日付/品目/仕入先）。金額不読は null。
// 出金額=税込合計(grossSales)／無ければ 税抜(netSales)+税。税=taxAmount。
// export はテスト用（運用上の呼び出しはこのモジュール内のみ）。
export function extractExpenseFromReceipt(
  receipt: LineImageReceiptAnalysis | null,
): { amount: number; tax: number; spentOn: string; item: string; supplier: string | null; items: PettyCashItem[]; taxMode: PettyTaxMode } | null {
  const tax = parseYenToInt(receipt?.taxAmount) ?? 0
  const gross = parseYenToInt(receipt?.grossSales)
  const net = parseYenToInt(receipt?.netSales)
  // supplier は下の税率整合チェック・品目分類のクロージャ（classifyPettyAcct への受け渡し）でも参照する。
  // 宣言が使用より後ろにあると TDZ の ReferenceError で経費解析全体が落ちるため、必ず関数先頭で宣言する
  // （実障害: 2026-07-11 fe9a512 で後方宣言のまま参照が追加され、小口レシート解析が全件失敗した）。
  const supplier = receipt?.storeName ? String(receipt.storeName).trim() : null
  // 商品明細（品名＋価格＋税率）。価格は数値化。
  const lineItems = Array.isArray(receipt?.lineItems) ? receipt!.lineItems! : []
  const itemRows = lineItems
    .map((li) => ({
      name: li?.name ? String(li.name).trim() : '',
      amount: parseYenToInt(li?.price),
      rate: (li?.rate === 8 || li?.rate === 10) ? li.rate : null,
    }))
    .filter((x) => x.name || x.amount != null)
    .slice(0, 30)
  // 西友で「商品1行の価格 = 小計/合計」になった結果は、実商品を読めていない誤解析。
  // 正しい1品購入まで拒否しないため、仕入先が西友かつ集計金額を商品価格に流用した場合だけ止める。
  const isSeiyuVendor = /(seiyu|西友)/i.test(String(supplier ?? ''))
  if (
    isSeiyuVendor &&
    itemRows.length === 1 &&
    itemRows[0].amount != null &&
    [gross, net].some((amount) => amount != null && Math.abs(amount - itemRows[0].amount!) <= 1)
  ) return null
  const itemsSum = itemRows.reduce((s, i) => s + (i.amount != null && i.amount > 0 ? i.amount : 0), 0)
  const allPriced = itemRows.length > 0 && itemRows.every((i) => i.amount != null && i.amount > 0)

  // 税率別集計（「◯%税込/うち税額」型の印字がある場合のみ AI が返す）。
  //   total=その税率の税込小計、tax=その中に含まれる税額（うち税額）。
  //   例: 10%税込¥5/うち税額¥0 ＋ 軽8%税込¥4,998/うち税額¥370 → 支払合計5,003・税370・税抜4,633。
  //   ※全店舗の経費レシートがこの型とは限らない（無いレシートでは breakdown は空）。
  const breakdown = (Array.isArray(receipt?.taxBreakdown) ? receipt!.taxBreakdown! : [])
    .map((b) => ({ rate: (b?.rate === 8 ? 8 : 10) as 8 | 10, total: parseYenToInt(b?.total), tax: parseYenToInt(b?.tax) ?? 0 }))
    .filter((b) => (b.rate === 8 || b.rate === 10) && b.total != null && b.total > 0 && b.tax >= 0 && b.tax <= (b.total ?? 0))
  const bdGross = breakdown.reduce((s, b) => s + (b.total ?? 0), 0)
  const bdTax = breakdown.reduce((s, b) => s + b.tax, 0)
  // 印字の「合計」と±2円以内で一致するときだけ信用（合計が読めない場合は集計行の和を採用）。
  const bdValid = breakdown.length > 0 && bdGross > 0 && (gross == null || Math.abs(bdGross - gross) <= 2)

  // 【税率の割当・最優先＝税率別集計から逆算】※印は小さくOCRが不安定なので、税率別小計が2種以上ある
  //   レシートでは、それを正として税率を決める: 税込小計が最大の税率を「多数派」とし、少数派(残りの税率)の
  //   小計に一致する品目を greedy に抜き出してその税率に割当、残りは多数派にする。
  //   例: 8%税込4,998 / 10%税込5 → ¥5の品目(レジ袋)だけ10%、残り全部8%（※を1つも読めなくても正しくなる）。
  //   ※価格未取得の品目(例: 買物袋¥5が読めない)があっても集計から税率を決められるよう allPriced を要件にしない。
  //   価格のある品目だけ greedy 照合し、価格が無い/一致しない品目は多数派の税率にする（高島屋で全品10%化を防ぐ）。
  //   ※これは「候補のひとつ」。AIが内訳を誤読する(例: 高島屋で8%対象を¥890と誤読→bdValid=true でも内訳だけ誤り)
  //     ことがあるため、下の【税率配分の整合チェック】で消費税合計と突き合わせて最終採用を決める。
  const bdRateByIndex = new Map<number, 8 | 10>()
  if (breakdown.length >= 2) {
    const sorted = [...breakdown].sort((a, b) => (b.total ?? 0) - (a.total ?? 0))
    const major = sorted[0].rate
    const used = new Set<number>()
    for (const m of sorted.slice(1)) {
      const target = m.total ?? 0
      const single = itemRows.findIndex((it, i) => !used.has(i) && it.amount != null && Math.abs(it.amount - target) <= 2)
      if (single >= 0) { bdRateByIndex.set(single, m.rate); used.add(single); continue }
      // 少数派が複数品のとき: 2品の合計一致まで試す。
      let paired = false
      for (let a = 0; a < itemRows.length && !paired; a++) {
        for (let b = a + 1; b < itemRows.length; b++) {
          if (used.has(a) || used.has(b)) continue
          const va = itemRows[a].amount, vb = itemRows[b].amount
          if (va != null && vb != null && Math.abs(va + vb - target) <= 2) {
            bdRateByIndex.set(a, m.rate); bdRateByIndex.set(b, m.rate); used.add(a); used.add(b); paired = true; break
          }
        }
      }
    }
    itemRows.forEach((_, i) => { if (!bdRateByIndex.has(i)) bdRateByIndex.set(i, major) })
  }

  // 【税率配分の整合チェック・最優先＝消費税合計に一致する配分を選ぶ・最重要】
  //   税率別集計(breakdown)の「内訳」はAIが誤読しやすい（高島屋で8%対象を¥890と読む等）。一方
  //   「消費税合計(taxAmount)」は印字を素直に読めて信頼できる（合計や品目価格からも裏取りできる）。
  //   そこで税率の決め方を「集計を盲信」から「複数の候補配分のうち、合計税額が信頼アンカーに最も一致する
  //   ものを採用」へ変える。候補=①集計の逆算 ②品目ごとのrate(外h=8/内#=10等) ③品名推定(食材8/他10)。
  //   どれかが消費税合計に±2円で一致すればそれを全品に採用（集計の内訳誤読・rate誤読のどちらでも自己修復）。
  //   アンカー（信頼できる「合計税額」）は複数集めて、どれかに一致すれば採用する（マルチアンカー）。
  //   ①消費税合計(印字) ②合計−税抜小計(net) ③合計−明細合計(税抜印字とみなせる時のみ)。
  //   ※③合計と明細価格は大きく確実に読めるので、誤読しやすい税率別内訳由来の①が数円ズレても③が救う。
  const taxAnchors: number[] = []
  // tax_amount はAIが「全品10%」で誤読することがあるため、検算で得られる税額を強アンカーとして優先する。
  const strongTaxAnchors: number[] = []
  if (tax > 0) taxAnchors.push(tax)
  if (gross != null && net != null && gross > net) {
    const grossMinusNet = gross - net
    taxAnchors.push(grossMinusNet)
    strongTaxAnchors.push(grossMinusNet)
  }
  if (gross != null && allPriced && gross > itemsSum
      && (gross - itemsSum) >= itemsSum * 0.04 && (gross - itemsSum) <= itemsSum * 0.11) {
    const grossMinusItems = gross - itemsSum
    taxAnchors.push(grossMinusItems)
    strongTaxAnchors.push(grossMinusItems)
  }
  let chosenRateOf: ((idx: number) => 8 | 10) | null = null
  // 集計の「内訳」が信頼アンカーと整合するか。false なら下流の明細補完(a)でも集計の内訳を使わない。
  //   アンカーが無い（判定不能）ときは従来どおり bdValid を信じる＝true 既定。
  let bdSplitTrusted = true
  if (taxAnchors.length > 0 && itemRows.length > 0) {
    // 配分の合計税額（税抜式・税込式の近い方）と、各アンカーの差の最小値。全品にrateが付かない候補は null。
    const taxDistForAnchors = (rateOf: (i: number) => 8 | 10 | null, anchors: number[]): number | null => {
      let g8 = 0, g10 = 0
      for (let i = 0; i < itemRows.length; i++) {
        const r = rateOf(i)
        if (r == null) return null
        const a = itemRows[i].amount
        const p = a != null && a > 0 ? a : 0
        if (r === 10) g10 += p; else g8 += p
      }
      const ex = Math.floor((g8 * 8) / 100) + Math.floor((g10 * 10) / 100)
      const inc = Math.floor((g8 * 8) / 108) + Math.floor((g10 * 10) / 110)
      let d = Infinity
      for (const an of anchors) d = Math.min(d, Math.abs(ex - an), Math.abs(inc - an))
      return d
    }
    const primaryTaxAnchors = strongTaxAnchors.length > 0 ? strongTaxAnchors : taxAnchors
    const taxDist = (rateOf: (i: number) => 8 | 10 | null): number | null => taxDistForAnchors(rateOf, primaryTaxAnchors)
    const food = (i: number): 8 | 10 => defaultPettyRate(classifyPettyAcct(itemRows[i].name, { supplier }))
    const bdCand = (i: number): 8 | 10 | null => bdRateByIndex.get(i) ?? null
    const cands: Array<(i: number) => 8 | 10 | null> = []
    if (bdRateByIndex.size) cands.push(bdCand)
    cands.push((i) => (itemRows[i].rate === 8 || itemRows[i].rate === 10) ? itemRows[i].rate as 8 | 10 : null)
    cands.push(food)
    let best: ((i: number) => 8 | 10 | null) | null = null, bestDist = Infinity
    for (const c of cands) {
      const d = taxDist(c)
      if (d != null && d < bestDist) { bestDist = d; best = c }
    }
    // 十分一致(±2円)した候補だけ全品に採用。穴(null)は品名推定で埋める。一致しなければ従来優先へフォールバック。
    if (best && bestDist <= 2) { const b = best; chosenRateOf = (idx) => (b(idx) ?? food(idx)) }
    // 集計の内訳がアンカーに一致しないなら、補完(a)でも集計を信用しない（高島屋の誤読集計でニセ補完を防ぐ）。
    if (bdRateByIndex.size) { const dBd = taxDist(bdCand); bdSplitTrusted = dBd != null && dBd <= 2 }
  }

  // 品目内訳（勘定科目・税率）。優先: ⓪整合チェックの採用配分 → ①税率別集計 → ②軽減税率印(rate=8) → ③品名推定。
  //   税率=8 は「酒類を除く飲食料品」の証拠なので科目=食材で確定。10% は科目を品名から推定。
  // 【Seria（100円ショップ）確定補正】Web版OCR(Groq)は store_name=Seria の識別はできても税率を
  //   rate=8 と取りこぼすことがある（小型モデルの追従限界）。Seria の商品は軽減税率の対象外＝全品10%で
  //   確定なので、store_name で検知したら rate を 10 に上書きする（rate=8 強制による科目「食材」化と
  //   外税8%上乗せの不一致を根本回避）。プロンプト側のSeriaブロックと二重の安全網。
  const isSeriaVendor = /(seria|セリア)/i.test(String(receipt?.storeName ?? ''))
  const isLawsonVendor = /(lawson|ローソン)/i.test(String(receipt?.storeName ?? ''))
  const isFamilyMartVendor = /(family\s*mart|familymart|ファミリーマート|ファミマ)/i.test(String(receipt?.storeName ?? ''))
  const itemEntries = itemRows.map((i, idx) => {
    const p = i.amount != null && i.amount > 0 ? i.amount : 0
    // 【酒類の確定補正】本みりん等の酒類は軽減税率の対象外＝法律上必ず10%。OCRや税率配分が
    //   8% と誤読しても「rate=8→食材で確定」ロジックに乗せず、税率10%・科目アルコールで確定する
    //   （実障害: 2026-07-14 クック-Y の宝酒造 本みりん ¥499 が 8%・食材となり出金額が¥10不一致）。
    const isAlcoholItem = classifyPettyAcct(i.name, { supplier }) === 'alcohol'
    let rate: 8 | 10
    if (isAlcoholItem) rate = 10
    else if (isSeriaVendor) rate = 10
    else if (chosenRateOf) rate = chosenRateOf(idx)
    else if (bdRateByIndex.has(idx)) rate = bdRateByIndex.get(idx)!
    else if (i.rate === 8 || i.rate === 10) rate = i.rate
    else rate = defaultPettyRate(classifyPettyAcct(i.name, { supplier }))
    const acct: 'shokuzai' | 'shomohin' | 'alcohol' = isAlcoholItem
      ? 'alcohol'
      : rate === 8
      ? 'shokuzai'
      : classifyPettyAcct(i.name, { rate, supplier })
    return { n: i.name || '(品目)', p, acct, rate }
  })
  // FamilyMart の小型レシートは同じ商品が複数行に分かれることがあり、OCRが2行目を落とすと
  // 下流の汎用補完が「(明細補完 10%対象)」のような実在しない品目を作ってしまう。
  // 1品の税込単価×整数個がレシート合計(gross)に一致する場合は、同じ商品行の繰り返しとして復元する。
  if (
    isFamilyMartVendor &&
    itemEntries.length === 1 &&
    gross != null &&
    gross > 0 &&
    itemEntries[0].p > 0 &&
    itemEntries[0].rate === 8
  ) {
    const count = Math.round(gross / itemEntries[0].p)
    if (count >= 2 && count <= 10 && Math.abs(itemEntries[0].p * count - gross) <= 2) {
      const first = itemEntries[0]
      for (let i = 1; i < count; i++) itemEntries.push({ ...first })
    }
  }
  // 税は税率ごとにまとめて1円未満切り捨て（レシートの「うち税額」と同じ方式）。
  let itB8 = 0, itB10 = 0
  for (const it of itemEntries) { if (it.rate === 10) itB10 += it.p; else itB8 += it.p }
  const itemsTax = Math.floor((itB8 * 8) / 100) + Math.floor((itB10 * 10) / 100)

  // 本体(税抜)・出金額(税込)の決定（誤読対策・上から優先）:
  //  0a) 【税率別集計】「◯%税込/うち税額」の印字から確定: 出金=Σ税込小計、税=Σうち税額、本体=出金−税。
  //      → 明細の1品を誤読しても、印字された集計行から金額が正しく決まる。
  //  0b) 【明細照合】全品目に価格があり「明細合計＋品目別税 ≒ 合計(gross)」(±3円)なら明細を正とする。
  //  1) 小計(net)+税(tax)。 2) 明細合計(itemsSum)+税。 3) 合計(gross)−税。
  let base: number | null = null
  let amount: number | null = null
  let taxResolved = tax
  const breakdownSuggestsGrossDoubleCount =
    breakdown.length > 0 &&
    bdGross > 0 &&
    bdTax >= 0 &&
    gross != null &&
    gross > 0 &&
    Math.abs(gross - (bdGross + bdTax)) <= 3 &&
    (!allPriced || Math.abs(itemsSum - bdGross) <= 3)
  const lawsonLikelyInternalTaxTotal =
    isLawsonVendor &&
    gross != null &&
    gross > 0 &&
    tax > 0 &&
    allPriced &&
    Math.abs(itemsSum - Math.max(0, gross - tax)) <= 3
  // bdValid でも【内訳が信頼アンカーと不整合(bdSplitTrusted=false)】なら集計のbdTaxを税額に使わない。
  //   下の明細照合(itemsSum+itemsTax≒gross)へ落として、整合チェックで直した税率配分どおりの税額にする。
  if (breakdownSuggestsGrossDoubleCount) {
    amount = bdGross
    taxResolved = Math.min(bdTax, amount)
    base = amount - taxResolved
  } else if (bdValid && bdSplitTrusted) {
    amount = gross ?? bdGross
    taxResolved = Math.min(bdTax, amount)
    base = amount - taxResolved
  } else if (lawsonLikelyInternalTaxTotal) {
    amount = itemsSum
    taxResolved = Math.min(tax, amount)
    base = amount - taxResolved
  } else if (gross != null && gross > 0 && allPriced && Math.abs(itemsSum + itemsTax - gross) <= 3) {
    base = itemsSum
    amount = gross
    taxResolved = Math.max(0, gross - itemsSum)
  } else if (gross != null && gross > 0 && allPriced && Math.abs(itemsSum - gross) <= 3) {
    // 【税込印字・税率別集計なし】明細価格(税込)の合計が支払総額(gross＝代金引換額/合計/今回出金額)に一致。
    //   宅急便コレクト/領収証など外税集計の無い税込レシートで起きる。amount=gross(税込)とし、税は
    //   税込から税率別に逆算(floor)。下の正規化で各品目pを税抜へ変換する（→台帳の「明細＋税＝出金額」検証が一致）。
    //   ※税を上乗せして二重課税にしない（出金額は実際に支払った税込額のまま）。
    amount = gross
    taxResolved = Math.floor((itB8 * 8) / 108) + Math.floor((itB10 * 10) / 110)
    base = amount - taxResolved
  } else if (net != null && net > 0) { base = net; amount = net + tax }
  else if (itemsSum > 0) { base = itemsSum; amount = itemsSum + tax }
  else if (gross != null && gross > 0) { amount = gross; base = Math.max(0, gross - tax) }
  if (base == null || amount == null || amount <= 0) return null
  if (isSeriaVendor && amount > 0) {
    // Seria は全品10%・税込。受領額(amount=税込総額)から本体/税を10%で確定し、明細＋税＝受領額 を保証（不一致警告を出さない）。
    taxResolved = amount - Math.round(amount / 1.1)
    base = amount - taxResolved
  }
  const safeTax = Math.min(taxResolved, amount)
  const spentOn = normalizeDateYmd(receipt?.date) ?? todayYmdJst()
  let taxMode: PettyTaxMode = breakdownSuggestsGrossDoubleCount ? 'in' : 'ex'

  // 【明細価格の 税込/税抜 自動判定（レシートごと）】店によって品目の印字が税込/税抜どちらもある。
  //   システムの品目価格(p)は「税抜」で統一しているため、レシートの数字から判定して正規化する:
  //     Σ印字価格 ≒ 本体(税抜合計) → 印字は税抜（そのまま。例: TOBU百貨店）
  //     Σ印字価格 ≒ 出金額(税込合計) → 印字は税込 → 各品目 p = round(p ÷ (1+税率)) で税抜へ変換
  //   どちらにも一致しない（±3円超）= 価格の誤読が混ざっている → 変換せず、確認カード/台帳の⚠検証に委ねる。
  if (allPriced && itemEntries.length) {
    const entrySum = itemEntries.reduce((s, it) => s + (it.p > 0 ? it.p : 0), 0)
    if (Math.abs(entrySum - base) <= 3) {
      // 税抜印字（そのまま）
    } else if (Math.abs(entrySum - amount) <= 3) {
      taxMode = 'in'
      for (const it of itemEntries) it.p = Math.round(it.p / (1 + it.rate / 100))
      // 丸め誤差で Σp が本体とズレた分は最大価格の品目で吸収（±品数程度まで）
      const diff = base - itemEntries.reduce((s, it) => s + it.p, 0)
      if (diff !== 0 && Math.abs(diff) <= itemEntries.length + 2) {
        const maxIt = itemEntries.reduce((a, b) => (b.p > a.p ? b : a))
        maxIt.p += diff
      }
    }
  }

  // 税率別集計が明瞭な外税レシートでは、端数処理により商品行の税込表示と税抜対象額が1〜2円ずれることがある。
  // 集計行を正本にして税率ごとの小さな差だけを補正し、明細＋税と受領額を一致させる。
  if (bdValid && bdSplitTrusted && itemEntries.length) {
    for (const b of breakdown) {
      const targetNet = Math.max(0, (b.total ?? 0) - b.tax)
      const entries = itemEntries.filter((it) => it.rate === b.rate && it.p > 0)
      const currentNet = entries.reduce((sum, it) => sum + it.p, 0)
      const diff = targetNet - currentNet
      if (entries.length && diff !== 0 && Math.abs(diff) <= 2) {
        const smallest = entries.reduce((a, b) => (b.p < a.p ? b : a))
        if (smallest.p + diff > 0) smallest.p += diff
      }
    }
  }

  // 【未取得品目の補完（支払総額を正本に）】AIは少額の税率グループ（外10のレジ袋等＝¥5/税0）を、品目だけで
  //   なく税率別集計の行ごと落とすことがある（折り目・微小値・行頭外10が1行だけ 等が原因）。確実に読める
  //   「支払総額(amount)」を正本に、明細＋税で満たない差額を補完する。受領額(amount/tax)自体は集計行/合計が正本。
  //   ※税込印字の品目は itemsGross≥amount で gap≤0 となり発動しない＝過補完を自動回避。
  if (amount != null && amount > 0 && itemEntries.length) {
    // (a) tax_breakdown が読めている税率は、その税抜小計を品目が満たすよう不足分を補完（税率は確定）。
    //     ※集計ベースなので価格未取得の品目があっても安全（高島屋で買物袋¥5が読めなくても10%¥5を補える）。
    //     ただし集計の内訳が信頼アンカーと不整合(bdSplitTrusted=false)なら使わない（誤読集計でのニセ補完を防ぐ）。
    //     FamilyMart は内税コンビニレシートで、10%対象行が無いのに汎用補完が架空の10%品目を作る事故があったため除外。
    if (bdValid && bdSplitTrusted && !isFamilyMartVendor) {
      for (const b of breakdown) {
        const groupNet = Math.max(0, (b.total ?? 0) - b.tax)
        const covered = itemEntries.reduce((s, it) => s + (it.rate === b.rate ? it.p : 0), 0)
        const missing = groupNet - covered
        if (missing >= 2) itemEntries.push({ n: `(明細補完 ${b.rate}%対象)`, p: missing, acct: b.rate === 8 ? 'shokuzai' : 'shomohin', rate: b.rate })
      }
    }
    // (b) それでも明細(税込)が支払総額に届かない＝AIが税率別集計の行ごと落とした税率がある。残差を補完。
    //     税率は tax_breakdown に無い方（多くは10%＝レジ袋等）を推定。税込/税抜の正規化が効く全品価格ありの時だけ。
    if (allPriced && !isFamilyMartVendor) {
      let g8 = 0, g10 = 0
      for (const it of itemEntries) { if (it.rate === 10) g10 += it.p; else g8 += it.p }
      const itemsGross = (g8 + g10) + Math.floor((g8 * 8) / 100) + Math.floor((g10 * 10) / 100)
      const gap = amount - itemsGross
      if (gap >= 2) {
        const rates = new Set(breakdown.map((b) => b.rate))
        const rate: 8 | 10 = (rates.has(8) && !rates.has(10)) ? 10 : (rates.has(10) && !rates.has(8)) ? 8 : 10
        const p = Math.max(1, Math.round(gap / (1 + rate / 100)))
        itemEntries.push({ n: `(明細補完 ${rate}%対象)`, p, acct: rate === 8 ? 'shokuzai' : 'shomohin', rate })
      }
    }
  }

  // 品目テキスト＋品目内訳（記録後に小口現金ページで修正可）。テキストは正規化後の税抜価格で表示。
  let item: string
  let items: PettyCashItem[]
  if (itemEntries.length) {
    item = itemEntries.map((i) => `・${i.n}${i.p > 0 ? ' ' + formatYen(i.p) : ''}`.trim()).join('\n')
    items = itemEntries
  } else {
    const nameItems = Array.isArray(receipt?.items) ? receipt!.items.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 8) : []
    // 品目が本当に何も読めていない時は、無理に代用品目（店名や「経費」）を作らず読み取り失敗として返す
    // （呼び出し元が「手入力してください」に案内する）。下の自己参照チェックと合わせて、
    // 「店名を品目名として使う」架空品目が生成される事故を防ぐ。
    if (nameItems.length === 0) return null
    item = nameItems.length > 1 ? nameItems.map((s) => '・' + s).join('\n') : nameItems[0]
    const nm = nameItems[0]
    const acct = classifyPettyAcct(nameItems.join(' '), { supplier })
    // 明細価格が取れない時は本体価格を1品目に集約（科目別集計の取りこぼしを防ぐ）。
    items = [{ n: nm, p: base, acct, rate: defaultPettyRate(acct) }]
  }
  // 【品目名が仕入先名そのものになっている自己参照を防ぐ・最終防波堤】
  // 併写のClaudia2レジ出金伝票（自店の入出金票）をAIが仕入先と誤認し、そのまま唯一の品目としても
  // 使ってしまう事故が複数回起きている（例: 仕入先「Claudia2」・品目「Claudia2」¥912。実在の
  // FamilyMartレシートの生しょうが・生にんにくが完全に無視された）。店名＝商品名は実在しないため、
  // 品目が1件かつ仕入先名と一致する場合は読み取り失敗として返す（誤った内容での自動登録を防ぐ）。
  if (items.length === 1 && supplier && items[0].n.trim().toLowerCase() === supplier.trim().toLowerCase()) {
    return null
  }
  return { amount, tax: safeTax, spentOn, item, supplier, items, taxMode }
}

function textMessage(text: string): Record<string, unknown> {
  return { type: 'text', text }
}

function guideFlex(storeName: string): Record<string, unknown> {
  return {
    type: 'flex',
    altText: '経費（小口現金）の取込',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: '経費（小口現金）として記録', weight: 'bold', size: 'lg', color: '#1a6fa8', wrap: true },
          { type: 'text', text: `店舗：${storeName}`, size: 'sm', color: '#444444', wrap: true },
          { type: 'text', text: '続けて、出金（経費）レシートの画像を送ってください。AIが本体価格・税額を読み取り、確認のうえ小口現金に記録します。', size: 'sm', color: '#444444', wrap: true },
          { type: 'text', text: '※これは「売上」には登録されません。やめる場合は下の「キャンセル」。', size: 'xs', color: '#8a96a3', wrap: true },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: 'キャンセル', text: 'キャンセル' } },
        ],
      },
    },
  }
}

function fieldRows(rows: Array<[string, string | null]>): Record<string, unknown>[] {
  return rows.filter(([, v]) => v && String(v).trim()).map(([label, v]) => ({
    type: 'box', layout: 'baseline', spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#8a96a3', flex: 2 },
      { type: 'text', text: String(v), size: 'sm', color: '#333333', flex: 5, wrap: true },
    ],
  }))
}

type ExtractedExpense = {
  storeDisplayName: string
  spentOn: string
  item: string | null
  amount: number
  tax: number
  taxMode: PettyTaxMode
  supplier: string | null
  /** 取扱者（画像を投稿したユーザーの表示名）。確認カード表示用。 */
  handler?: string | null
  items?: PettyCashItem[] | null
}

// 明細（全品目に価格あり）の税込合計。価格欠けがあれば null（照合不能）。
function itemsTotalWithTax(items?: PettyCashItem[] | null): number | null {
  if (!Array.isArray(items) || !items.length) return null
  if (!items.every((it) => Number(it?.p) > 0)) return null
  // 税は税率ごとにまとめて1円未満切り捨て。
  let b8 = 0, b10 = 0
  for (const it of items) { if (it.rate === 10) b10 += it.p; else b8 += it.p }
  const base = b8 + b10
  const tax = Math.floor((b8 * 8) / 100) + Math.floor((b10 * 10) / 100)
  return base + tax
}

function confirmFlex(pendingId: number, x: ExtractedExpense): Record<string, unknown> {
  const base = Math.max(0, x.amount - x.tax)
  const acctLabel = pettyItemsLabel(x.items) || '—'
  // 検証: 明細の税込合計(税率別＋切り捨て)と支払合計のズレ(±1円超)は黙って通さず、警告＋「不一致を確認して記録」にする。
  const itemsTotal = itemsTotalWithTax(x.items)
  const mismatch = itemsTotal != null && Math.abs(itemsTotal - x.amount) > 1
  const warnRows: Record<string, unknown>[] = mismatch
    ? [{
        type: 'text',
        text: `⚠️ 明細の合計（税込 ${formatYen(itemsTotal!)}）と支払合計（${formatYen(x.amount)}）が一致しません。品目の価格に読み取りミスがある可能性があります。記録する場合は、小口現金ページの「編集」で明細を修正してください。`,
        wrap: true, size: 'xs', color: '#c0392b', margin: 'md',
      }]
    : []
  return {
    type: 'flex',
    altText: `経費の記録確認: ${x.item ?? ''} ${formatYen(x.amount)}`.slice(0, 380),
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: '小口現金に記録しますか？', weight: 'bold', size: 'md', color: '#1a6fa8' },
          { type: 'text', text: '出金（経費）レシートを読み取りました。内容を確認して記録してください。', wrap: true, size: 'xs', color: '#8a96a3' },
          { type: 'separator', margin: 'md' },
          ...fieldRows([
            ['店舗', x.storeDisplayName],
            ['日付', x.spentOn],
            ['仕入先', x.supplier],
            ['勘定科目', acctLabel],
            ['品目', x.item],
            ['本体', formatYen(base)],
            ['税額', x.tax > 0 ? formatYen(x.tax) : '—'],
            ['出金額', formatYen(x.amount)],
            ['取扱者', x.handler && String(x.handler).trim() ? String(x.handler).trim() : '—'],
          ]),
          ...warnRows,
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: mismatch ? '#c0392b' : '#1a6fa8', action: { type: 'postback', label: mismatch ? '不一致を確認して記録' : 'この内容で記録', data: `pcimp=${pendingId}`, displayText: '小口現金に記録します' } },
          { type: 'button', style: 'secondary', action: { type: 'postback', label: '破棄（記録しない）', data: `pcimp_skip=${pendingId}`, displayText: '経費の記録を取りやめます' } },
        ],
      },
    },
  }
}

function simpleNoticeFlex(text: string): Record<string, unknown> {
  return {
    type: 'flex',
    altText: text.slice(0, 380),
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text, wrap: true, size: 'sm', color: '#333333' }] },
    },
  }
}

/** 出金日 YYYY-MM-DD から対象月 YYYY-MM を取る（ページの月フィルタ用）。 */
export function pettyCashMonthFromSpentOn(spentOn: string | null | undefined): string {
  const s = String(spentOn ?? '').trim()
  const m = s.match(/^(\d{4})-(\d{2})/)
  return m ? `${m[1]}-${m[2]}` : ''
}

// 小口現金ページのURLを組み立てる（store_key で店舗指定、from=line でロック、lt はワンタイムログイン、
// month で記録した出金月を開く＝前回閲覧月の localStorage に張り付いて「無い」と誤認しない）。
export function buildPettyCashPageUrl(
  storeKey: string,
  loginToken?: string | null,
  spentOnOrMonth?: string | null,
): string {
  const key = String(storeKey || '').trim()
  const lt = String(loginToken ?? '').trim()
  const month = pettyCashMonthFromSpentOn(spentOnOrMonth)
    || (/^\d{4}-\d{2}$/.test(String(spentOnOrMonth ?? '').trim()) ? String(spentOnOrMonth).trim() : '')
  const params = new URLSearchParams({ store_key: key, from: 'line' })
  if (month) params.set('month', month)
  if (lt) {
    params.set('lt', lt)
    const withToken = `${PETTY_CASH_PAGE_BASE}?${params.toString()}`
    if (withToken.length <= LINE_PETTY_URI_MAX_LEN) return withToken
    params.delete('lt')
  }
  return `${PETTY_CASH_PAGE_BASE}?${params.toString()}`
}

// 売上分析（レシート）と同じ仕組み: ワンタイムのログインリンク(lt)を発行し、
// 店舗を限定（その店舗のみ閲覧）した小口現金ページのURLを返す。発行失敗時はトークン無しURL。
async function buildPettyCashDashboardLink(
  supabase: SupabaseClient,
  storeKey: string,
  spentOn?: string | null,
): Promise<string> {
  const key = String(storeKey || '').trim()
  if (!key) return ''
  try {
    const issued = await issueAdminDashboardLoginLinkToken(supabase, {
      source: 'line_petty_cash',
      store_partition_key: key,
      scope: PETTY_CASH_SCOPE,
    })
    return buildPettyCashPageUrl(key, issued.token, spentOn)
  } catch (e) {
    console.error('buildPettyCashDashboardLink failed:', e instanceof Error ? e.message : String(e))
    return buildPettyCashPageUrl(key, null, spentOn)
  }
}

function doneFlex(p: PendingRow, pageUrl?: string | null): Record<string, unknown> {
  const amount = Math.max(0, Math.floor(Number(p.amount_yen ?? 0)))
  const tax = Math.max(0, Math.floor(Number(p.tax_yen ?? 0)))
  const base = Math.max(0, amount - tax)
  const acctLabel = pettyItemsLabel(p.items) || String(p.category ?? '').trim() || '—'
  const bubble: Record<string, unknown> = {
    type: 'bubble',
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        { type: 'text', text: '✅ 小口現金に記録しました', weight: 'bold', size: 'md', color: '#1a7f37' },
        { type: 'separator', margin: 'md' },
        ...fieldRows([
          ['日付', p.spent_on],
          ['勘定科目', acctLabel],
          ['品目', p.item],
          ['本体', formatYen(base)],
          ['税額', tax > 0 ? formatYen(tax) : '—'],
          ['出金額', formatYen(amount)],
          ['取扱者', p.handler && String(p.handler).trim() ? String(p.handler).trim() : '—'],
        ]),
        { type: 'text', text: '下のボタンから小口現金ページ（出金・経費）を開いて確認・編集できます。', size: 'xs', color: '#8a96a3', margin: 'md', wrap: true },
      ],
    },
  }
  const url = String(pageUrl ?? '').trim()
  if (url) {
    bubble.footer = {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        {
          type: 'button', style: 'primary', color: '#1a7f37', height: 'sm',
          action: { type: 'uri', label: '小口現金ページを開く', uri: url },
        },
      ],
    }
  }
  return { type: 'flex', altText: '小口現金に記録しました', contents: bubble }
}

type PendingRow = {
  id: number
  status: string
  store_partition_key: string | null
  line_message_id: string | null
  spent_on: string | null
  item: string | null
  amount_yen: number | null
  tax_yen: number | null
  tax_mode: PettyTaxMode | null
  handler: string | null
  store_name: string | null
  category: string | null
  items: PettyCashItem[] | null
}

async function clearPending(supabase: SupabaseClient, key: string): Promise<void> {
  try { await supabase.from(PENDING_TABLE).delete().eq('conversation_key', key) } catch (_e) { /* noop */ }
}

async function sendReply(
  replyToken: string,
  messages: Record<string, unknown>[],
  storeKey: string,
  roomId: string,
): Promise<boolean> {
  const accessToken = resolveChannelAccessToken(storeKey)
  if (!replyToken || !accessToken) return false
  try {
    const r = await replyLineMessages(replyToken, messages, accessToken, {
      storePartitionKey: storeKey,
      context: 'petty_cash',
      roomId,
    })
    return r.ok
  } catch (_e) { return false }
}

// テキスト処理: 「経費」で画像待ちに、pending中の「キャンセル」で中止。それ以外は従来処理へフォールスルー。
export async function handlePettyCashTextMessage(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  args: { roomId: string; userId: string | null; replyToken: string; text: string },
): Promise<PettyCashTextResult> {
  const { roomId, userId, replyToken, text } = args
  const isTrigger = TRIGGER_WORDS.has(text)
  const isCancel = CANCEL_WORDS.has(text)
  if (!isTrigger && !isCancel) return { handled: false, replied: false }

  const key = conversationKey(roomId, userId)
  const storeKey = String(registry.store_partition_key ?? '').trim()
  const storeName = String(registry.display_name ?? '').trim() || storeKey

  if (isCancel) {
    // 経費pendingがある時だけ中止を引き受ける（無ければ従来処理へ）。
    const { data } = await supabase.from(PENDING_TABLE).select('status').eq('conversation_key', key).maybeSingle()
    const st = String((data as { status?: unknown } | null)?.status ?? '')
    if (st !== 'await_image' && st !== 'await_confirm') return { handled: false, replied: false }
    await clearPending(supabase, key)
    const replied = await sendReply(replyToken, [textMessage('経費（小口現金）の記録を中止しました。')], storeKey, roomId)
    return { handled: true, replied }
  }

  // トリガー: 画像待ちに設定（既存pendingは上書き）。
  const nowIso = new Date().toISOString()
  const expiresAt = new Date(Date.now() + PENDING_TTL_MIN * 60 * 1000).toISOString()
  const { error } = await supabase.from(PENDING_TABLE).upsert({
    conversation_key: key,
    room_id: roomId,
    user_id: userId || null,
    store_partition_key: storeKey || null,
    status: 'await_image',
    line_message_id: null,
    spent_on: null, item: null, amount_yen: null, tax_yen: null, tax_mode: null, handler: null, store_name: null, category: null,
    expires_at: expiresAt,
    updated_at: nowIso,
  }, { onConflict: 'conversation_key' })
  if (error) {
    const replied = await sendReply(replyToken, [textMessage('経費の受付を開始できませんでした。少し時間を置いて「経費」と送り直してください。')], storeKey, roomId)
    return { handled: true, replied }
  }
  const replied = await sendReply(replyToken, [guideFlex(storeName)], storeKey, roomId)
  return { handled: true, replied }
}

// 取扱者＝レシート画像をトークルームに投稿したLINEユーザーの表示名。
// 1) line_user_permissions のキャッシュ（webhook で同期済みのことが多い）→ 2) 無ければ LINE API で取得。
// 取得できなければ null（取扱者は空欄のまま記録）。
async function resolveHandlerDisplayName(
  supabase: SupabaseClient,
  storeKey: string,
  roomId: string,
  userId: string | null,
): Promise<string | null> {
  const uid = String(userId ?? '').trim()
  if (!uid) return null
  try {
    const { data } = await supabase
      .from('line_user_permissions')
      .select('display_name')
      .eq('line_user_id', uid)
      .maybeSingle()
    const cached = String((data as { display_name?: unknown } | null)?.display_name ?? '').trim()
    if (cached) return cached
  } catch (_e) { /* キャッシュ不可なら API へフォールバック */ }
  try {
    const token = resolveChannelAccessToken(storeKey)
    if (!token) return null
    const live = await fetchLineDisplayNameByUserId(uid, String(roomId ?? '').trim(), token)
    return live || null
  } catch (_e) {
    return null
  }
}

// 画像処理: 経費pending(await_image)があれば、この画像を経費として扱う（売上に登録しない）。
// pending が無ければ {handled:false} を返し、従来のレシート処理へフォールスルー。
export async function handlePettyCashImageIfPending(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  args: { roomId: string; userId: string | null; replyToken: string; lineMessageId: string; receipt: LineImageReceiptAnalysis | null; summary: string; reanalyze?: () => Promise<LineImageReceiptAnalysis | null> },
): Promise<PettyCashImageResult> {
  const { roomId, userId, replyToken, lineMessageId, receipt } = args
  const key = conversationKey(roomId, userId)
  const storeKey = String(registry.store_partition_key ?? '').trim()
  const storeName = String(registry.display_name ?? '').trim() || storeKey

  const { data } = await supabase
    .from(PENDING_TABLE)
    .select('id, status, expires_at')
    .eq('conversation_key', key)
    .maybeSingle()
  if (!data) return { handled: false, replied: false }
  const status = String((data as { status?: unknown }).status ?? '')
  if (status !== 'await_image') return { handled: false, replied: false }
  const exp = String((data as { expires_at?: unknown }).expires_at ?? '')
  if (exp && Date.parse(exp) <= Date.now()) {
    await clearPending(supabase, key)
    return { handled: false, replied: false }
  }
  const pendingId = Number((data as { id?: unknown }).id ?? 0)

  // 経費専用に再解析（明細・小計/外税を取得）。失敗時のみ売上解析をフォールバック。売上(精算)解析には非依存。
  const receiptForExpense = (args.reanalyze ? await args.reanalyze() : null) ?? receipt
  // 自店の売上日計精算レポートは、経費待ち(await_image)であっても絶対に経費にしない。
  // pending は消さずに残すので、続けて本来の経費レシートを送ればそのまま経費として処理できる。
  if (looksLikeSalesSettlementReceipt(receiptForExpense)) {
    console.info(`[petty_cash] sales settlement report passed through to sales flow (store=${storeKey}, msg=${lineMessageId})`)
    return { handled: false, replied: false, reason: 'petty_cash_sales_report_passthrough' }
  }
  const ex = extractExpenseFromReceipt(receiptForExpense)
  if (!ex) {
    await clearPending(supabase, key)
    const replied = await sendReply(replyToken, [simpleNoticeFlex('レシートの金額を読み取れませんでした。お手数ですが小口現金ページから手入力してください。')], storeKey, roomId)
    return { handled: true, replied, saved: false, reason: 'petty_cash_amount_unreadable' }
  }

  // 取扱者＝画像を投稿したユーザーの表示名（記録まで持ち越す）。
  const handlerName = await resolveHandlerDisplayName(supabase, storeKey, roomId, userId)
  await supabase.from(PENDING_TABLE).update({
    status: 'await_confirm',
    line_message_id: lineMessageId,
    spent_on: ex.spentOn,
    item: ex.item,
    amount_yen: ex.amount,
    tax_yen: ex.tax,
    tax_mode: ex.taxMode,
    handler: handlerName,
    store_name: ex.supplier,
    items: ex.items,
    updated_at: new Date().toISOString(),
  }).eq('id', pendingId)

  const replied = await sendReply(replyToken, [confirmFlex(pendingId, {
    storeDisplayName: storeName, spentOn: ex.spentOn, item: ex.item, amount: ex.amount, tax: ex.tax, taxMode: ex.taxMode, supplier: ex.supplier, items: ex.items, handler: handlerName,
  })], storeKey, roomId)
  return { handled: true, replied, saved: false, reason: 'petty_cash_confirm_card' }
}

// 店名不一致などで売上登録されなかったレシートを「経費候補」として pending(await_confirm) に保存し、
// 確認ボタン用の pendingId を返す（金額不読なら null＝ボタンを出さない）。
// これで「経費」と先に打たなくても、画像→不一致カードの「経費として記録」ボタンで小口記録できる。
export async function savePettyCashPendingFromReceipt(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  args: { roomId: string; userId: string | null; lineMessageId: string; receipt: LineImageReceiptAnalysis | null; reanalyze?: () => Promise<LineImageReceiptAnalysis | null> },
): Promise<number | null> {
  const { roomId, userId, lineMessageId, receipt } = args
  // 経費専用に再解析（明細・小計/外税）。失敗時のみ売上解析をフォールバック。
  const receiptForExpense = (args.reanalyze ? await args.reanalyze() : null) ?? receipt
  // 店名不一致でも、売上の日計精算レポートを経費候補にしてはいけない（別店舗の売上レポートの誤送信）。
  if (looksLikeSalesSettlementReceipt(receiptForExpense)) return null
  const ex = extractExpenseFromReceipt(receiptForExpense)
  if (!ex) return null
  const storeKey = String(registry.store_partition_key ?? '').trim()
  const key = conversationKey(roomId, userId)
  const nowIso = new Date().toISOString()
  const expiresAt = new Date(Date.now() + PENDING_TTL_MIN * 60 * 1000).toISOString()
  // 取扱者＝画像を投稿したユーザーの表示名。
  const handlerName = await resolveHandlerDisplayName(supabase, storeKey, roomId, userId)
  const { data, error } = await supabase.from(PENDING_TABLE).upsert({
    conversation_key: key,
    room_id: roomId,
    user_id: userId || null,
    store_partition_key: storeKey || null,
    status: 'await_confirm',
    line_message_id: lineMessageId,
    spent_on: ex.spentOn,
    item: ex.item,
    amount_yen: ex.amount,
    tax_yen: ex.tax,
    tax_mode: ex.taxMode,
    handler: handlerName,
    store_name: ex.supplier,
    category: null,
    items: ex.items,
    expires_at: expiresAt,
    updated_at: nowIso,
  }, { onConflict: 'conversation_key' }).select('id').single()
  if (error) {
    console.error('savePettyCashPendingFromReceipt failed:', error.message)
    return null
  }
  return Number((data as { id?: number } | null)?.id ?? 0) || null
}

// レジ出金（経費）伝票の検知。売上ではないので売上登録せず、経費記録を案内する。
// 検知しなければ {handled:false}（従来の売上処理へフォールスルー）。
export async function handlePettyCashCashOutSlip(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  args: { roomId: string; userId: string | null; replyToken: string; lineMessageId: string; receipt: LineImageReceiptAnalysis | null; summary: string; reanalyze?: () => Promise<LineImageReceiptAnalysis | null> },
): Promise<PettyCashImageResult> {
  const { roomId, userId, replyToken, lineMessageId, receipt, summary, reanalyze } = args
  // 検知は売上解析の summary / store_name / items（レジ出金マーカー）で行う。
  // ベンダー領収書と一緒に写っていてもAIがどこかに「レジ出金」を出せば拾えるよう対象を広めに取る。
  const haystack = [
    summary ?? '',
    receipt?.storeName ?? '',
    Array.isArray(receipt?.items) ? receipt!.items.join(' ') : '',
  ].join(' ')
  if (!CASH_OUT_MARKERS.test(haystack)) return { handled: false, replied: false }

  // 出金伝票＝売上ではない。以降は売上登録しない（handled:true で確定）。
  // 金額・明細は経費専用に再解析（売上解析プロンプトには非依存）。失敗時のみ売上解析をフォールバック。
  const storeKey = String(registry.store_partition_key ?? '').trim()
  const exReceipt = (reanalyze ? await reanalyze() : null) ?? receipt
  const pendingId = await savePettyCashPendingFromReceipt(supabase, registry, { roomId, userId, lineMessageId, receipt: exReceipt })
  if (!pendingId) {
    const replied = await sendReply(replyToken, [simpleNoticeFlex('レジ出金（経費）の伝票のようです。売上には登録していません。金額が読み取れなかったため、小口現金ページから手入力してください。')], storeKey, roomId)
    return { handled: true, replied, saved: false, reason: 'petty_cash_cashout_unreadable' }
  }
  const confirm = await handlePettyCashPostback(supabase, registry, `pcreview=${pendingId}`)
  const replied = await sendReply(replyToken, [confirm ?? simpleNoticeFlex('出金（経費）レシートを読み取りました。小口現金ページから内容をご確認ください。')], storeKey, roomId)
  return { handled: true, replied, saved: false, reason: 'petty_cash_cashout_confirm' }
}

// 確認カードの postback。
//   pcreview=<id>   … 解析結果の確認カードを表示（記録しない）。不一致カードの「経費として記録」から来る。
//   pcimp=<id>      … この内容で記録（petty_cash_entries へ）
//   pcimp_skip=<id> … 破棄
export async function handlePettyCashPostback(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  postbackData: string,
): Promise<Record<string, unknown> | null> {
  const isReview = postbackData.startsWith('pcreview=')
  const isRecord = postbackData.startsWith('pcimp=')
  const isSkip = postbackData.startsWith('pcimp_skip=')
  if (!isReview && !isRecord && !isSkip) return null
  const id = Number(postbackData.split('=')[1] ?? '')
  if (!Number.isInteger(id) || id <= 0) return null

  const { data: pending, error } = await supabase
    .from(PENDING_TABLE)
    .select('id, status, store_partition_key, line_message_id, spent_on, item, amount_yen, tax_yen, tax_mode, handler, store_name, category, items')
    .eq('id', id)
    .maybeSingle()
  if (error || !pending) return simpleNoticeFlex('対象の経費が見つかりませんでした。')
  const p = pending as PendingRow

  if (p.status === 'recorded') return simpleNoticeFlex('この経費はすでに記録済みです。')
  if (p.status !== 'await_confirm') return simpleNoticeFlex('この経費は無効です。レシートを送り直すか「経費」と送ってやり直してください。')

  // 解析結果の確認カードを表示（記録はしない）。
  if (isReview) {
    const storeName = String(registry.display_name ?? '').trim() || String(p.store_partition_key ?? '')
    return confirmFlex(p.id, {
      storeDisplayName: storeName,
      spentOn: p.spent_on ?? '',
      item: p.item,
      amount: Math.max(0, Math.floor(Number(p.amount_yen ?? 0))),
      tax: Math.max(0, Math.floor(Number(p.tax_yen ?? 0))),
      taxMode: p.tax_mode === 'in' ? 'in' : 'ex',
      supplier: p.store_name,
      handler: p.handler,
      items: p.items,
    })
  }

  // 破棄
  if (isSkip) {
    await supabase.from(PENDING_TABLE).update({ status: 'dismissed', updated_at: new Date().toISOString() }).eq('id', id)
    return simpleNoticeFlex('経費の記録を取りやめました。')
  }

  // 記録（pcimp）
  const amount = Math.max(0, Math.floor(Number(p.amount_yen ?? 0)))
  const tax = Math.min(amount, Math.max(0, Math.floor(Number(p.tax_yen ?? 0))))
  if (!p.store_partition_key || !p.spent_on || amount <= 0) {
    return simpleNoticeFlex('記録に必要な情報が不足しています。小口現金ページから手入力してください。')
  }

  const itemsLabel = pettyItemsLabel(p.items)
  const { error: insErr } = await supabase.from(ENTRIES_TABLE).insert({
    store_partition_key: p.store_partition_key,
    spent_on: p.spent_on,
    item: p.item,
    category: itemsLabel || p.category,
    amount_yen: amount,
    tax_yen: tax,
    tax_mode: p.tax_mode === 'in' ? 'in' : 'ex',
    items: p.items,
    handler: p.handler,
    note: p.store_name ? ('仕入先: ' + p.store_name) : null,
    source: 'line_image',
    line_message_id: p.line_message_id,
  })
  if (insErr) {
    console.error('petty_cash insert failed:', insErr.message)
    // line_message_id 一意制約の重複だけ「記録済み」。それ以外は未記録のままリトライ可能にする。
    const isDup = /duplicate|unique|line_message_id/i.test(String(insErr.message || ''))
    if (isDup) {
      await supabase.from(PENDING_TABLE).update({ status: 'recorded', updated_at: new Date().toISOString() }).eq('id', id)
      // 重複でも出金月付きリンクを返し、別月フィルタで「無い」と誤認しない
      const pageUrl = await buildPettyCashDashboardLink(supabase, String(p.store_partition_key ?? ''), p.spent_on)
      return pageUrl
        ? doneFlex(p, pageUrl)
        : simpleNoticeFlex('この経費はすでに記録済みです。小口現金ページで出金日の月を選んでご確認ください。')
    }
    return simpleNoticeFlex('記録に失敗しました。しばらくしてからもう一度「この内容で記録」を押すか、小口現金ページから手入力してください。')
  }
  await supabase.from(PENDING_TABLE).update({ status: 'recorded', updated_at: new Date().toISOString() }).eq('id', id)
  // 売上分析と同じ仕組みで、その店舗のみ閲覧できる小口現金ページへのワンタイムログインリンクを付ける。
  // spent_on の月を URL に載せ、前回閲覧の別月（例: 7月）で開いて「無い」と誤認しない。
  const pageUrl = await buildPettyCashDashboardLink(supabase, String(p.store_partition_key ?? ''), p.spent_on)
  return doneFlex(p, pageUrl)
}
