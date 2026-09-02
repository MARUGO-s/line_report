// 店舗ナレッジ（資料）に添付されたファイルから、Gemini へ渡すテキストを抽出する共通モジュール。
//
// 現行Geminiモデルが inlineData で直接受け取れるのは画像と PDF のみ。
// Excel(.xlsx/.xlsm) と Word(.docx) はバイナリのまま渡しても解釈できないため、
// ここでプレーンテキストへ変換してから text パートとして渡す。
//
// PDF も Gemini に直接読ませられるが、ページ数が多いと全文の文字起こしが出力上限に
// 当たり、body_text が空のまま返ってくる（18ページのメニュー集で実際に発生した）。
// 埋め込みテキストを持つ PDF はここで取り出し、確実に全文を渡す。
// 文字を持たないスキャン画像PDFだけを Gemini の inlineData へ回す。

import * as XLSX from "https://esm.sh/xlsx@0.18.5"
import { strFromU8, unzipSync } from "https://esm.sh/fflate@0.8.2"
import { extractText, getDocumentProxy } from "https://esm.sh/unpdf@1.3.2"

export type KnowledgeFileKind =
  | "image" // Gemini に inlineData でそのまま渡す
  | "pdf" // 同上（Gemini は application/pdf をネイティブ対応）
  | "spreadsheet" // XLSX でテキスト化してから渡す
  | "document" // docx を展開してテキスト化してから渡す
  | "text" // そのままデコードして渡す
  | "unsupported"

/** Gemini へ渡すテキストの上限。長大な表で入力が膨らみ過ぎるのを防ぐ。 */
export const KNOWLEDGE_EXTRACT_MAX_CHARS = 60000

export function classifyKnowledgeFile(fileName: string, mimeType: string): KnowledgeFileKind {
  const name = String(fileName || "").toLowerCase()
  const mime = String(mimeType || "").toLowerCase()

  if (mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|heic|heif)$/.test(name)) return "image"
  if (mime === "application/pdf" || /\.pdf$/.test(name)) return "pdf"
  if (
    mime.includes("spreadsheetml") || mime === "application/vnd.ms-excel" ||
    /\.(xlsx|xlsm|xls)$/.test(name)
  ) return "spreadsheet"
  if (mime.includes("wordprocessingml") || /\.docx$/.test(name)) return "document"
  if (mime.startsWith("text/") || mime === "application/csv" || mime === "application/json") {
    return "text"
  }
  if (/\.(txt|csv|tsv|md|markdown|json)$/.test(name)) return "text"
  return "unsupported"
}

/** 抽出結果が実質空（空白のみ）かどうか。 */
export function isBlankExtract(text: string): boolean {
  return !String(text || "").replace(/\s+/g, "")
}

function clip(text: string): string {
  const s = String(text || "")
  return s.length > KNOWLEDGE_EXTRACT_MAX_CHARS ? s.slice(0, KNOWLEDGE_EXTRACT_MAX_CHARS) : s
}

/** Excel(.xlsx/.xlsm) の全シートを「シート名 + CSV」のテキストへ変換する。 */
export function extractSpreadsheetText(bytes: Uint8Array): string {
  try {
    const wb = XLSX.read(bytes, { type: "array" })
    const parts: string[] = []
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName]
      if (!ws) continue
      const csv = String(XLSX.utils.sheet_to_csv(ws, { blankrows: false }) || "").trim()
      if (!csv) continue
      parts.push(`【シート: ${sheetName}】\n${csv}`)
    }
    return clip(parts.join("\n\n"))
  } catch (err) {
    console.error("extractSpreadsheetText failed:", err)
    return ""
  }
}

/** Word(.docx) の本文テキストを抽出する。docx は ZIP なので word/document.xml を展開して使う。 */
export function extractDocxText(bytes: Uint8Array): string {
  try {
    const files = unzipSync(bytes)
    const xmlBytes = files["word/document.xml"]
    if (!xmlBytes) return ""
    const xml = strFromU8(xmlBytes)
    const text = xml
      // 段落・改行・タブを先に可読な文字へ置換してからタグを落とす
      .replace(/<w:p[ >][^>]*>|<w:p>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<w:br\s*\/?>/g, "\n")
      .replace(/<w:tab\s*\/?>/g, "\t")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
    return clip(text)
  } catch (err) {
    console.error("extractDocxText failed:", err)
    return ""
  }
}

/** PDF の埋め込みテキストをページ単位で取り出す。
 * ページ見出しを付けるのは、月ごとにページが分かれた資料で境界を保つため。
 * スキャン画像だけの PDF では空文字を返し、呼び出し側が Gemini の画像解析へ回す。 */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  try {
    const pdf = await getDocumentProxy(bytes)
    const { text } = await extractText(pdf, { mergePages: false })
    const pages = Array.isArray(text) ? text : [String(text ?? "")]
    const parts: string[] = []
    pages.forEach((raw, index) => {
      const page = String(raw ?? "").trim()
      if (page) parts.push(`【${index + 1}ページ】\n${page}`)
    })
    return clip(parts.join("\n\n"))
  } catch (err) {
    console.error("extractPdfText failed:", err)
    return ""
  }
}

/** テキスト系ファイルを UTF-8 として読む。 */
export function extractPlainText(bytes: Uint8Array): string {
  try {
    return clip(new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim())
  } catch (err) {
    console.error("extractPlainText failed:", err)
    return ""
  }
}

/**
 * ファイル種別に応じて Gemini へ渡せるテキストを取り出す。
 * image は inlineData で直接渡すため空文字を返す（呼び出し側で分岐）。
 * pdf はテキストを持つなら返し、持たない（スキャン画像）なら空文字を返す。
 */
export async function extractKnowledgeText(
  kind: KnowledgeFileKind,
  bytes: Uint8Array,
): Promise<string> {
  if (kind === "pdf") return await extractPdfText(bytes)
  if (kind === "spreadsheet") return extractSpreadsheetText(bytes)
  if (kind === "document") return extractDocxText(bytes)
  if (kind === "text") return extractPlainText(bytes)
  return ""
}

/** 添付ファイル名から拡張子を推定する（LINE 経由で fileName が取れない場合の保存名用）。 */
export function extensionForKind(kind: KnowledgeFileKind, mimeType: string): string {
  const mime = String(mimeType || "").toLowerCase()
  if (kind === "pdf") return "pdf"
  if (kind === "spreadsheet") return "xlsx"
  if (kind === "document") return "docx"
  if (kind === "text") return mime.includes("csv") ? "csv" : "txt"
  if (mime.includes("png")) return "png"
  if (mime.includes("webp")) return "webp"
  return "jpg"
}
