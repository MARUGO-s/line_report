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
  '画像がレシート/領収書なら kind を receipt にし、主要項目を抽出してください。',
  'レシートでない場合は kind を general にし、summary に1文（80文字以内）で内容を入れてください。',
  'summary は必ず 1 行にし、改行を含めないこと。',
  'JSONスキーマ:',
  '{"kind":"receipt|general","summary":"string","receipt_confidence":0.0,"receipt":{"store_name":"string|null","store_phone":"string|null","date":"string|null","net_sales":"string|null","tax_amount":"string|null","gross_sales":"string|null","party_count":"string|null","guest_count":"string|null","unit_price":"string|null","items":["string"]}}',
  'store_phone はレシート上部の電話番号（例: 03-5361-6205）。読めない場合は null。',
  'receipt は kind=general の時は null でも可。items は最大5件まで。読めない項目は null。',
  'kind=receipt のときは receipt_confidence に 0.0〜1.0 の数値を必ず入れる。',
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

/**
 * コード側に常駐する店舗固有のレシート解析ルール（恒久・UIで消えない）。
 * DB追記より優先で先頭に置く。例: 鮨こるりは手書きの「売上日報」をレシート扱いにする必要がある。
 */
const STORE_BUILTIN_RECEIPT_PROMPT: Record<string, string> = {
  sushikoruri: [
    '【鮨こるり 固有ルール（最優先）】',
    '・手書き/印字を問わず「売上日報」「日報」など“その日の売上を集計したメモ”は、レシート/領収書と同等とみなし必ず kind=receipt とする（kind=general にしない）。',
    '・「店舗名」→ store_name（例: 鮨こるり）。',
    '・「日付」→ date（西暦。"2026年6月2日"のような手書き数字は桁を一字ずつ丁寧に読み、年の誤読に注意）。',
    '・「カード売上」＋「現金売上」の合計金額を gross_sales に入れる（¥表記）。片方が0でも合計する。',
    '・「◯組◯名」表記があれば ◯組→party_count、◯名→guest_count（数値）。「1組1名」なら party_count=1, guest_count=1。',
    '・上記の主要項目が読めれば receipt_confidence は 0.6 以上とする。',
  ].join('\n'),
}

/** 指定店舗のコード常駐ルール（無ければ空文字）。 */
export function resolveBuiltinStoreReceiptPrompt(storePartitionKey: string | null | undefined): string {
  const key = String(storePartitionKey ?? '').trim().toLowerCase()
  return STORE_BUILTIN_RECEIPT_PROMPT[key] ?? ''
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
