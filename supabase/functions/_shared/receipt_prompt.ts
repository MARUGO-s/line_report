import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'

/** 店舗別追記プロンプトの最大文字数（トークン肥大・事故防止）。 */
export const STORE_RECEIPT_PROMPT_MAX_CHARS = 2000

/**
 * Groq ビジョン解析の既定システムプロンプト（コード側が常に保持する土台）。
 * ここは全店舗共通。店舗固有の対応は store_receipt_analysis_prompts の追記で行う（基盤は変更しない）。
 * ※ 既存の receipt_vision.ts のシステム文面と一字一句同一にしてある（挙動を変えないため）。
 */
export const RECEIPT_VISION_SYSTEM_PROMPT_BASE: string = [
  'あなたは画像解析アシスタントです。必ず JSON のみを返してください（説明文・コードブロック禁止）。',
  '画像が横向き・逆向きの場合は、頭の中で正立に回転してから読むこと。',
  '画像がレシート/領収書/売上日報なら kind を receipt にし、主要項目を抽出してください。',
  '画像が「予約管理アプリ/予約サイトの予約確認画面」（＝来店予定日・来店時間・人数・予約者名・電話番号・コース等が並ぶ“未来の来店予約”の画面。売上金額の合計や税額は無い）なら kind を reservation にし、reservation に各項目を入れてください。',
  'レシートでも予約確認画面でもない場合は kind を general にし、summary に1文（80文字以内）で内容を入れてください。',
  'summary は必ず 1 行にし、改行を含めないこと。',
  'JSONスキーマ:',
  '{"kind":"receipt|reservation|general","summary":"string","receipt_confidence":0.0,"receipt":{"store_name":"string|null","store_phone":"string|null","date":"string|null","net_sales":"string|null","tax_amount":"string|null","gross_sales":"string|null","party_count":"string|null","guest_count":"string|null","unit_price":"string|null","items":["string"],"line_items":[{"name":"string|null","price":"string|null"}]},"reservation":{"date":"YYYY-MM-DD|null","time":"HH:MM|null","booking_date":"YYYY-MM-DD|null","party_size":"string|null","customer_name":"string|null","customer_phone":"string|null","course":"string|null","store_name":"string|null","table":"string|null","status":"string|null","allergy":"string|null","dislikes":"string|null","anniversary":"string|null","notes":"string|null"}}',
  'store_phone はレシート上部の電話番号（例: 03-5361-6205）。読めない場合は null。',
  'receipt は kind!=receipt の時は null でも可。reservation は kind!=reservation の時は null でも可。items は最大5件まで。読めない項目は null。',
  'レシートに商品明細があれば line_items に1件ずつ入れる: {"name":"品名","price":"¥価格"}（例: {"name":"お徳用おろし生姜","price":"¥299"}）。最大10件。小計(税抜)=net_sales、税額(外税/内税)=tax_amount、合計(税込)=gross_sales を必ず読み分ける。「お預り」「お釣り」は支払総額ではないので gross_sales に入れない。',
  'kind=receipt のときは receipt_confidence に 0.0〜1.0 の数値を必ず入れる。',
  'reservation.date は必ず西暦の "YYYY-MM-DD" 形式に正規化（例: 2026年6月12日(金) → "2026-06-12"）。reservation.time は来店開始時刻を "HH:MM"（例: 18:00〜20:30 → "18:00"）。',
  '画面の左上などに表示される日付は「予約を登録した日＝予約登録日（予約受付日）」であり、来店日とは別物。これは booking_date に入れて "YYYY-MM-DD" に正規化する。来店日（実際に来店する日）は date に入れ、両者を絶対に混同しない。',
  '予約確認画面に「メモ/備考/特記事項/リクエスト/コメント」欄があれば必ず読み取る: アレルギー(例: 甲殻類NG)→allergy、苦手・嫌いな食材→dislikes、記念日・誕生日・バースデー・お祝い→anniversary、席や接客などその他の要望・注記→notes。複数該当は「、」で連結。手書きの書き込みも対象。該当が無い項目は null。',
  '金額は可能なら「¥7,700」の形式。会計組数・客数は数値として抽出。summary は必須。',
].join('\n')

/**
 * 既定プロンプト＋店舗別の追記（任意）を連結したシステムプロンプトを返す。
 * 追記は「補足」として末尾に足すだけで、JSON形式・出力ルール（基盤）は常に保持される。
 */
export function buildReceiptVisionSystemPrompt(customAddition?: string | null): string {
  const add = String(customAddition ?? '').trim().slice(0, STORE_RECEIPT_PROMPT_MAX_CHARS)
  if (!add) return RECEIPT_VISION_SYSTEM_PROMPT_BASE
  return [
    RECEIPT_VISION_SYSTEM_PROMPT_BASE,
    '',
    '--- この店舗固有の補足（項目の対応や読み方はこれを最優先で従う。ただし上記のJSON形式・出力ルールは厳守する） ---',
    add,
  ].join('\n')
}

/** 鮨こるりの固有ルール。手書き数字の誤読補正のため、解析時点の本日(JST)を埋め込む。 */
function buildSushikoruriBuiltinPrompt(): string {
  const jstNow = new Date(Date.now() + 9 * 3600 * 1000)
  const y = jstNow.getUTCFullYear()
  const m = jstNow.getUTCMonth() + 1
  const d = jstNow.getUTCDate()
  return [
    '【鮨こるり 固有ルール（最優先）】',
    '・手書き/印字を問わず「売上日報」「日報」など“その日の売上を集計したメモ”は、レシート/領収書と同等とみなし必ず kind=receipt とする（kind=general にしない）。',
    '・ただし「お品書き・メニュー・献立・本日のネタ」など“寿司ネタ/料理名/産地の一覧”で、売上金額（カード/現金/合計）・組数・客数の集計が無いものは、手書きでも必ず kind=general とし receipt には入れない（売上日報ではない）。日付・店名・ネタ名の羅列だけで金額や組数/客数が無ければ general。',
    '・「店舗名」→ store_name（例: 鮨こるり）。',
    '・「カード売上」＋「現金売上」の合計金額を gross_sales に入れる（¥表記）。片方が0でも合計する。',
    '・「◯組◯名」表記があれば ◯組→party_count、◯名→guest_count（数値）。「1組1名」なら party_count=1, guest_count=1。',
    '・上記の主要項目が読めれば receipt_confidence は 0.6 以上とする。',
    '・【日付の読み取り注意】この用紙の手書き数字は「1」と「6」が酷似していて誤読しやすい。年・月・日のいずれでも 1↔6 を取り違えないよう特に注意する（例: 6 を 1 と誤読すると「2026」が「2021」に、「16日」が「11日」になりやすい）。読めた数字が 1 のときは、本当は 6 ではないか必ず見直す。',
    `・本日(JST)は ${y}年${m}月${d}日。読み取った西暦(date の年)が本日の年(${y})から大きく外れる（おおむね2年以上のズレ）場合は、ほぼ確実に 1↔6 等の誤読なので、西暦は本日の年(${y})に自動補正して date に入れる。`,
    '・date は西暦で「YYYY年M月D日」の形にする。月・日は通常は当月〜直近数日のはずで、極端に離れた値は 1↔6 の誤読を疑う（ただし日は当日へ強制せず、用紙の数字を尊重しつつ明らかな誤読のみ補正する）。',
  ].join('\n')
}

/** バルペロタ（BAR PELOTA）固有ルール。組数を「総取引数」と取り違える誤りを必ず無くす。 */
function buildBarpelotaBuiltinPrompt(): string {
  return [
    '【バルペロタ（BAR PELOTA）固有ルール（最優先・必ず従う）】',
    '・【最重要・kind判定】店名「BAR PELOTA」で、合計・純売上・客数・総取引数・通常取引数 などの精算項目が並ぶ画像は、反射・光・かすれ・一部不鮮明・斜め撮影があっても必ず kind="receipt" とする。kind を "general" や "reservation" にしては絶対にいけない（要約に「レシート」と書けるなら必ず receipt として扱う）。',
    '・読めない項目が一部あっても、読める主要項目（純売上・合計・客数・通常取引数 など）だけでも receipt に入れて kind=receipt を維持し、receipt_confidence は 0.6 以上にする。',
    '・このレシート（精算）は毎回同じテンプレートで、「総取引数」と「通常取引数」が別々の行に並ぶ。両者を絶対に混同しないこと。',
    '・会計組数（party_count）には必ず「通常取引数」の数値だけを採用する。「総取引数」を party_count にしては絶対にいけない。',
    '  例: 「総取引数 … 35」「通常取引数 … 34」と並ぶレシートなら party_count="34"（＝通常取引数）。',
    '・客数（guest_count）は「客数」行の数値（例: 75）。「総取引数」「販売点数」と取り違えない。',
    '・売上・税額など他の項目は通常どおり（純売上=net_sales、税込合計=gross_sales）。',
  ].join('\n')
}

/**
 * コード側に常駐する店舗固有のレシート解析ルール（恒久・UIで消えない）。
 * DB追記より優先で先頭に置く。例: 鮨こるりは手書きの「売上日報」をレシート扱いにする必要がある。
 */
const STORE_BUILTIN_RECEIPT_PROMPT_BUILDERS: Record<string, () => string> = {
  sushikoruri: buildSushikoruriBuiltinPrompt,
  barpelota: buildBarpelotaBuiltinPrompt,
}

/** 指定店舗のコード常駐ルール（無ければ空文字）。 */
export function resolveBuiltinStoreReceiptPrompt(storePartitionKey: string | null | undefined): string {
  const key = String(storePartitionKey ?? '').trim().toLowerCase()
  const builder = STORE_BUILTIN_RECEIPT_PROMPT_BUILDERS[key]
  return builder ? builder() : ''
}

/** コード常駐ルール（先頭＝優先）とDB追記を結合し、全体を上限内に収める。 */
export function combineStoreReceiptPromptAdditions(
  builtin: string | null | undefined,
  dbAddition: string | null | undefined,
): string {
  const parts = [String(builtin ?? '').trim(), String(dbAddition ?? '').trim()].filter(Boolean)
  return parts.join('\n\n').slice(0, STORE_RECEIPT_PROMPT_MAX_CHARS)
}

/**
 * 店舗別レシート解析プロンプトの追記を取得（enabled かつ非空のときのみ）。
 * 未設定・無効・エラー時は空文字（＝既定プロンプトのまま）。
 */
export async function fetchStoreReceiptAnalysisPromptAddition(
  supabase: SupabaseClient,
  storePartitionKey: string | null | undefined,
): Promise<string> {
  const key = String(storePartitionKey ?? '').trim()
  if (!key) return ''
  try {
    const { data, error } = await supabase
      .from('store_receipt_analysis_prompts')
      .select('prompt, enabled')
      .eq('store_partition_key', key)
      .maybeSingle()
    if (error || !data) return ''
    if ((data as { enabled?: boolean }).enabled === false) return ''
    return String((data as { prompt?: string }).prompt ?? '').trim().slice(0, STORE_RECEIPT_PROMPT_MAX_CHARS)
  } catch (_e) {
    return ''
  }
}
