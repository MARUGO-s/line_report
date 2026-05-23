export type LineImageReceiptAnalysis = {
  storeName: string | null
  date: string | null
  netSales: string | null
  taxAmount: string | null
  grossSales: string | null
  partyCount: string | null
  guestCount: string | null
  unitPrice: string | null
  items: string[]
}

export type LineImageAnalysisResult = {
  summary: string
  receipt: LineImageReceiptAnalysis | null
  receiptModelConfidence?: number | null
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

export const RECEIPT_ANALYSIS_CONFIDENCE_MIN = 0.52
export const GROQ_VISION_BASE64_MAX_BYTES = 3 * 1024 * 1024
export const RECEIPT_BUDGET_BUSINESS_DAY_START_HOUR_JST = 5
