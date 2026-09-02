export type LineImageReceiptAnalysis = {
  storeName: string | null
  /** レシート印字の電話番号（03-xxxx-xxxx 等） */
  storePhone: string | null
  date: string | null
  /** レシートに印字された精算時刻（営業日判定用）。例: "00:12:02" */
  printedTime?: string | null
  netSales: string | null
  taxAmount: string | null
  grossSales: string | null
  partyCount: string | null
  guestCount: string | null
  unitPrice: string | null
  items: string[]
  /** 商品明細（品名＋価格＋税率）。経費（小口現金）の明細表示・品目別税率に使用。任意（解析時のみ設定）。 */
  lineItems?: Array<{ name: string | null; price: string | null; rate?: number | null }>
  /** 税率別集計（「◯%税込/うち税額」等の印字がある場合のみ）。total=税込小計、tax=うち税額。経費の金額確定に使用。 */
  taxBreakdown?: Array<{ rate: number; total: string | null; tax: string | null }>
}

/** 予約管理アプリ等の「予約確認画面」スクショから抽出する予約情報 */
export type LineImageReservationAnalysis = {
  date: string | null        // 来店日 "YYYY-MM-DD"（解析後に正規化）
  time: string | null        // 来店開始時刻 "HH:MM"
  bookingDate: string | null // 予約登録日（画面左上の日付＝予約を登録した日。来店日とは別）
  partySize: string | null   // 人数
  customerName: string | null
  customerPhone: string | null
  course: string | null      // コース/プラン
  storeName: string | null
  tableNo: string | null     // 卓番
  status: string | null      // 新規/変更/キャンセル 等
  allergy: string | null     // アレルギー
  dislikes: string | null    // 苦手/嫌いな食材
  anniversary: string | null // 記念日/誕生日/バースデー/お祝い
  notes: string | null       // その他メモ/備考/要望/特記事項
}

/** 店舗メニュー画像。M-talkでは資料登録前の確認カードにだけ使う。 */
export type LineImageMenuAnalysis = {
  title: string | null
  summary: string | null
  menuItems: Array<{
    section: string | null
    name: string | null
    price: string | null
    description: string | null
  }>
  bodyText: string | null
  extractionNotes: string | null
  tags: string[]
}

export type LineImageAnalysisResult = {
  summary: string
  receipt: LineImageReceiptAnalysis | null
  receiptModelConfidence?: number | null
  reservation?: LineImageReservationAnalysis | null
  menu?: LineImageMenuAnalysis | null
}

export type LineImageVisionFailure = {
  stage: string
  message: string
  httpStatus?: number
}

export type MonthCumulativeTotals = {
  grossSalesYen: number | null
  partyCount: number | null
  guestCount: number | null
}

export type LineReplyPayload =
  | string
  | Record<string, unknown>
  | Array<string | Record<string, unknown>>

export const RECEIPT_ANALYSIS_CONFIDENCE_MIN = 0.52
export const GROQ_VISION_BASE64_MAX_BYTES = 3 * 1024 * 1024
export const RECEIPT_BUDGET_BUSINESS_DAY_START_HOUR_JST = 5
