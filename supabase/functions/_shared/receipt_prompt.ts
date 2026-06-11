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
  '{"kind":"receipt|reservation|general","summary":"string","receipt_confidence":0.0,"receipt":{"store_name":"string|null","store_phone":"string|null","date":"string|null","net_sales":"string|null","tax_amount":"string|null","gross_sales":"string|null","party_count":"string|null","guest_count":"string|null","unit_price":"string|null","items":["string"]},"reservation":{"date":"YYYY-MM-DD|null","time":"HH:MM|null","booking_date":"YYYY-MM-DD|null","party_size":"string|null","customer_name":"string|null","customer_phone":"string|null","course":"string|null","store_name":"string|null","table":"string|null","status":"string|null","allergy":"string|null","dislikes":"string|null","anniversary":"string|null","notes":"string|null"}}',
  'store_phone はレシート上部の電話番号（例: 03-5361-6205）。読めない場合は null。',
  'receipt は kind!=receipt の時は null でも可。reservation は kind!=reservation の時は null でも可。items は最大5件まで。読めない項目は null。',
  'kind=receipt のときは receipt_confidence に 0.0〜1.0 の数値を必ず入れる。',
  'reservation.date は必ず西暦の "YYYY-MM-DD" 形式に正規化（例: 2026年6月12日(金) → "2026-06-12"）。reservation.time は来店開始時刻を "HH:MM"（例: 18:00〜20:30 → "18:00"）。',
  '画面の左上などに表示される日付は「予約を登録した日＝予約登録日（予約受付日）」であり、来店日とは別物。これは booking_date に入れて "YYYY-MM-DD" に正規化する。来店日（実際に来店する日）は date に入れ、両者を絶対に混同しない。',
  '予約確認画面に「メモ/備考/特記事項/リクエスト/コメント」欄があれば必ず読み取る: アレルギー(例: 甲殻類NG)→allergy、苦手・嫌いな食材→dislikes、記念日・誕生日・バースデー・お祝い→anniversary、席や接客などその他の要望・注記→notes。複数該当は「、」で連結。手書きの書き込みも対象。該当が無い項目は null。',
  '金額は可能なら「¥7,700」の形式。会計組数・客数は数値として抽出。summary は必須。',
].join('\n')

// ── 経費（小口現金）解析プロンプト ─────────────────────────────────────────
// 売上(精算)レシートには一切使わない＝独立。共通プロンプト本体(RECEIPT_VISION_SYSTEM_PROMPT_BASE)は
// 変更せず、経費の再解析時のみ systemPromptAddition として連結して line_items 等を取得する。
//
// 構成 = 「共通コア（全レシートに共通の普遍ルール）」＋「仕入先/形式別ブロック（発動条件つき）」。
//   ・新しい仕入先・レシート形式で誤読が出たら EXPENSE_VENDOR_PROMPT_BLOCKS にブロックを1つ追加するだけ。
//     他のブロックや共通コアには触れない＝既存仕入先の解析を壊さない。
//   ・各ブロックは必ず「発動条件」（ロゴ／適格請求書登録番号／電話／レイアウト特徴）から書き始めること。
//     条件に合致しないレシートには適用されない＝他の仕入先に干渉しない。
//   ・AIへは合成して1プロンプトで渡す（仕入先の事前判定は不要＝AI呼び出しは増えない）。

type ExpenseVendorPromptBlock = {
  /** 仕入先・レシート形式の名前（整理用。プロンプトの見出しにも使う） */
  vendor: string
  /** 発動条件つきのルール行（「〜の場合のみ適用」を必ず含めること） */
  rules: string[]
}

/** 全レシート共通の普遍ルール（仕入先に依存しない読み方）。 */
const EXPENSE_RECEIPT_PROMPT_CORE: string[] = [
  '【経費（小口現金）レシート専用】この画像は店舗の「売上」ではなく、店舗が支払った経費（仕入・備品など）の購入レシート（または出金伝票）です。kind は receipt のままでよい。',
  'JSONの receipt に追加で line_items（商品明細）を必ず含めること: "line_items":[{"name":"品名","price":"¥価格","rate":8}]（rate は消費税率 8 または 10）。例: [{"name":"お徳用おろし生姜","price":"¥299","rate":8},{"name":"食器用洗剤","price":"¥880","rate":10}]。読めない価格は null。',
  '【明細は全品目・打ち切り禁止（最重要）】line_items にはレシートに印字された**全部の商品**を必ず出力すること（上限30件）。「items は最大5件」の制限は line_items には適用されない。5〜6件で出力をやめるのは誤り。「合計 ◯点」とあれば line_items の件数を◯点に一致させること（例: 合計8点なら line_items は8件）。',
  '【明細の基本】品名は印字どおり忠実に転記し、読みにくい文字を推測で別の単語に置き換えない（読めた部分だけでよい）。',
  '【税率記号】品名の先頭/末尾の「※」「*」「軽」は軽減税率8%対象の印。印のある品目は**必ず rate=8 にする（10 にしてはならない）**。脚注に「※は軽減税率対象商品です」等があれば必ず従う。印の無い品目は飲食料品=8、それ以外（レジ袋・日用品・酒類）=10。',
  '金額は厳密に読み分ける: 小計(税抜)=net_sales、消費税額(外税/内税)=tax_amount、合計(税込・支払総額)=gross_sales。「お預り(預り金)」「お釣り」は支払総額ではないので gross_sales に絶対に入れない。',
  '【内税（税込）レシートの読み分け・最重要】「◯%税込 ¥X」の直後の「うち税額 ¥Y」は、**そのX円の中にY円の税が含まれている**という意味（例: 「10%税込¥5/うち税額¥0」=5円の中に税0円、「軽8%税込¥4,998/うち税額¥370」=4,998円の中に税370円。支払合計=5+4,998=5,003円）。この形式では gross_sales=「合計」の支払総額、tax_amount=各税率の「うち税額」の合計（例: ¥370+¥0="¥370"）、net_sales=gross_sales−tax_amount。「◯%税込 ¥X」の X は税込小計であり、絶対に net_sales や tax_amount に入れてはならない。',
  '【税率別集計 tax_breakdown（レシートに税率別の集計行が印字されている場合のみ必須）】receipt に "tax_breakdown":[{"rate":8,"total":"¥4,998","tax":"¥370"},{"rate":10,"total":"¥5","tax":"¥0"}] を含めること。total=その税率の**税込**小計（外税表記なら対象額＋その消費税の合計）、tax=その中に含まれる税額（「うち税額」）。印字された数値だけを使い、税率別集計が無いレシートでは tax_breakdown を出さなくてよい。',
  '【仕入れ先店名（store_name）】必ずレシートの一番上にある店名（最上部のロゴ・社名）を採用すること。住所・地名・取扱商品名・「◯◯店」「◯◯支店」などを店名と取り違えない。最上部が装飾ロゴで読みにくい場合は、下の仕入先別ルールの手がかり（登録番号・電話など）を最優先で適用する。',
]

/**
 * 仕入先・レシート形式別ルール（恒久・コード常駐）。
 * 追加方法: { vendor: '名前', rules: ['発動条件 → 適用内容', ...] } を1つ足すだけ。他は触らない。
 */
const EXPENSE_VENDOR_PROMPT_BLOCKS: ExpenseVendorPromptBlock[] = [
  {
    vendor: 'クック-Y（業務食材店）',
    rules: [
      '発動条件（いずれか1つでOK）: 上部ロゴが「クック」＋「Y」のように見える ／ 適格請求書登録番号が "T5011401006431" ／ 電話番号が "03-5367-2825"。',
      '→ 該当時は store_name を必ず "クック-Y" にする（装飾ロゴでも確定）。装飾ロゴの "クック-Y" を「クッキー」と読み崩さないこと。「クッキー」「クッキー新宿」「クッキー◯◯」など “クッキー” を含む名称には絶対にしない。支店名・地名（「新宿」等）・「店」も付けない。',
    ],
  },
  {
    vendor: '百貨店・スーパーのJANコード行形式（TOBU 等）',
    rules: [
      '発動条件: 「JANコード等の数字だけの行」と「品名 …… ¥価格」の行が交互に並ぶレイアウトの場合のみ適用。',
      '→ 数字だけの行（JANコード）は明細として拾わず無視する。品名と同じ行の右端の ¥金額を price としてペアで拾う（末尾の「#」「*」等の記号は金額に含めない）。',
    ],
  },
]

export const EXPENSE_RECEIPT_PROMPT_ADDITION = [
  ...EXPENSE_RECEIPT_PROMPT_CORE,
  ...EXPENSE_VENDOR_PROMPT_BLOCKS.flatMap((b) => [
    `【仕入先別ルール: ${b.vendor}】`,
    ...b.rules.map((r) => '・' + r),
  ]),
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

/** クラウディア2 固有。経費でよく使う仕入先「クック-Y」を装飾ロゴから誤読（「クッキー新宿」等）しないようにする。 */
function buildClaudia2BuiltinPrompt(): string {
  return [
    '【クラウディア2 固有・店名（store_name）の読み取り（最優先）】',
    '・store_name は必ずレシート最上部（一番上）の店名・ロゴを採用する。住所・地名・取扱商品名・「◯◯店」を店名と取り違えない。',
    '・よく使う仕入先「クック-Y」の手がかり（いずれか1つでOK）: 上部ロゴが「クック」＋「Y」に見える ／ 適格請求書登録番号 "T5011401006431" ／ 電話 "03-5367-2825"。該当時は store_name="クック-Y" にし、装飾ロゴを「クッキー」「クッキー新宿」等と絶対に読まない（“クッキー”を含む名称・支店名・地名にしない）。',
  ].join('\n')
}

/**
 * コード側に常駐する店舗固有のレシート解析ルール（恒久・UIで消えない）。
 * DB追記より優先で先頭に置く。例: 鮨こるりは手書きの「売上日報」をレシート扱いにする必要がある。
 */
const STORE_BUILTIN_RECEIPT_PROMPT_BUILDERS: Record<string, () => string> = {
  sushikoruri: buildSushikoruriBuiltinPrompt,
  barpelota: buildBarpelotaBuiltinPrompt,
  claudia2: buildClaudia2BuiltinPrompt,
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
