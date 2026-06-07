export type LineImageReceiptAnalysis = {
  storeName: string | null
  /** レシート印字の電話番号（03-xxxx-xxxx 等） */
  storePhone: string | null
  date: string | null
  netSales: string | null
  taxAmount: string | null
  grossSales: string | null
  partyCount: string | null
  guestCount: string | null
  unitPrice: string | null
  items: string[]
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

export type LineImageAnalysisResult = {
  summary: string
  receipt: LineImageReceiptAnalysis | null
  receiptModelConfidence?: number | null
  reservation?: LineImageReservationAnalysis | null
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
