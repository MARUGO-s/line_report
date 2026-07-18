import type { LineImageAnalysisResult, LineImageVisionFailure } from './receipt_types.ts'
import { GROQ_VISION_BASE64_MAX_BYTES } from './receipt_types.ts'
import {
  normalizeInlineText,
  normalizeLineImageAnalysisResult,
  parseFirstJsonObject,
  salvageLineImageAnalysisResultFromText,
} from './receipt_parse.ts'
import { buildReceiptVisionSystemPrompt } from './receipt_prompt.ts'

const VISION_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png'])
export const GROQ_VISION_MODEL = 'qwen/qwen3.6-27b'
export const AZURE_FOUNDRY_VISION_MODEL = 'gpt-5.4-nano'

function isVisionAnalyzableImageMime(contentType: string | null): boolean {
  return VISION_IMAGE_MIME_TYPES.has(String(contentType ?? '').trim().toLowerCase())
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

/** AI解析1回の実測トークン使用量（課金推定用）。output は思考トークン込みの課金対象出力。 */
export type LineImageVisionUsage = {
  inputTokens: number
  outputTokens: number
  thinkingTokens: number | null
  totalTokens: number
}

function toTokenCount(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

/** Gemini レスポンスの usageMetadata から実測トークンを取り出す。 */
function extractGeminiUsage(payload: unknown): LineImageVisionUsage | null {
  const u = (payload as { usageMetadata?: Record<string, unknown> })?.usageMetadata
  if (!u || typeof u !== 'object') return null
  const input = toTokenCount(u.promptTokenCount)
  const total = toTokenCount(u.totalTokenCount)
  const thinking = u.thoughtsTokenCount == null ? null : toTokenCount(u.thoughtsTokenCount)
  // 課金対象の出力は「思考込み」。candidatesTokenCount が思考を含む版/含まない版があるため、
  // total - prompt で堅牢に算出する（APIの版差を吸収）。
  const output = Math.max(0, total - input)
  if (input <= 0 && total <= 0) return null
  return { inputTokens: input, outputTokens: output, thinkingTokens: thinking, totalTokens: total }
}

/** Groq（OpenAI互換）レスポンスの usage から実測トークンを取り出す。 */
function extractGroqUsage(payload: unknown): LineImageVisionUsage | null {
  const u = (payload as { usage?: Record<string, unknown> })?.usage
  if (!u || typeof u !== 'object') return null
  const input = toTokenCount(u.prompt_tokens)
  const output = toTokenCount(u.completion_tokens)
  const total = toTokenCount(u.total_tokens) || (input + output)
  if (input <= 0 && output <= 0 && total <= 0) return null
  return { inputTokens: input, outputTokens: output, thinkingTokens: null, totalTokens: total }
}

/** Azure AI Foundry Responses API の usage から実測トークンを取り出す。 */
function extractAzureFoundryUsage(payload: unknown): LineImageVisionUsage | null {
  const u = (payload as { usage?: Record<string, unknown> })?.usage
  if (!u || typeof u !== 'object') return null
  const input = toTokenCount(u.input_tokens)
  const output = toTokenCount(u.output_tokens)
  const total = toTokenCount(u.total_tokens) || (input + output)
  const details = u.output_tokens_details as Record<string, unknown> | undefined
  const thinking = details?.reasoning_tokens == null ? null : toTokenCount(details.reasoning_tokens)
  if (input <= 0 && output <= 0 && total <= 0) return null
  return { inputTokens: input, outputTokens: output, thinkingTokens: thinking, totalTokens: total }
}

function extractAzureFoundryOutputText(payload: unknown): string {
  const direct = (payload as { output_text?: unknown })?.output_text
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const output = (payload as { output?: unknown })?.output
  const messages = Array.isArray(output) ? output : []
  const parts: string[] = []
  for (const message of messages) {
    const content = (message as { content?: unknown })?.content
    for (const part of (Array.isArray(content) ? content : [])) {
      const text = (part as { text?: unknown })?.text
      if (typeof text === 'string' && text.trim()) parts.push(text)
    }
  }
  return parts.join('\n').trim()
}

export function isTransientLineImageVisionFailure(
  failure: LineImageVisionFailure | null | undefined,
): boolean {
  if (!failure) return false
  const status = Number(failure.httpStatus ?? 0)
  if (status === 429 || status >= 500) return true
  return /(?:network_error|fetch_error|timeout|invalid_json|empty_content|unparsable_model_output)$/.test(
    String(failure.stage ?? ''),
  )
}

/** Groq側の障害・設定不整合なら、入力画像自体の不備を除いて別プロバイダーへ退避する。 */
export function shouldFallbackLineImageVisionFailure(
  failure: LineImageVisionFailure | null | undefined,
): boolean {
  if (!failure) return false
  return !/^(?:invalid_image_size|unsupported_mime)$/.test(String(failure.stage ?? ''))
}

export async function analyzeLineImageWithGroqScout(
  bytes: Uint8Array,
  contentType: string | null,
  fileName: string,
  groqApiKey: string,
  systemPromptAddition = '',
  timeoutMs = 25000,
  retryDelayMs = 600,
): Promise<{ analysis: LineImageAnalysisResult | null; failure: LineImageVisionFailure | null; usage?: LineImageVisionUsage | null }> {
  if (!groqApiKey) {
    return { analysis: null, failure: { stage: 'missing_api_key', message: 'GROQ_API_KEY is missing.' } }
  }
  if (bytes.byteLength <= 0 || bytes.byteLength > GROQ_VISION_BASE64_MAX_BYTES) {
    return {
      analysis: null,
      failure: { stage: 'invalid_image_size', message: `Image bytes out of range: ${bytes.byteLength}` },
    }
  }
  const mime = String(contentType ?? '').trim().toLowerCase()
  if (!isVisionAnalyzableImageMime(mime)) {
    return {
      analysis: null,
      failure: { stage: 'unsupported_mime', message: `Unsupported image mime: ${mime || '(empty)'}` },
    }
  }

  const imageDataUrl = `data:${mime};base64,${toBase64(bytes)}`
  const requestBody = JSON.stringify({
    model: GROQ_VISION_MODEL,
    response_format: { type: 'json_object' },
    temperature: 0.1,
    // 経費(line_items)など明細つきJSONが途中切断されないよう余裕を持たせる
    // （max_tokensは上限であり実出力分しか課金されない。380では明細つきで切れる）。
    max_tokens: 1500,
    messages: [
      {
        role: 'system',
        content: buildReceiptVisionSystemPrompt(systemPromptAddition),
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `この画像を解析してください。ファイル名: ${fileName || '(unknown)'}` },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
  })

  // Groq はスパイク時に 503/500/429 を一時的に返すことがある（実障害: 2026-07-01 bistrocavacava の
  // レシートが 503 で保存されず消失。Groq単独店はフォールバック先が無いためそのまま取りこぼす）。
  // 一過性の 5xx/429・ネットワーク断だけ、短い待機で1回だけ再試行する。恒久エラー(4xx)は再試行しない。
  const maxAttempts = 2
  let response: Response | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    const boundedTimeoutMs = Math.max(250, Math.min(timeoutMs, 60000))
    const timer = setTimeout(() => controller.abort(), boundedTimeoutMs)
    try {
      response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${groqApiKey}`,
          'Content-Type': 'application/json',
        },
        body: requestBody,
        signal: controller.signal,
      })
    } catch (e) {
      const timedOut = controller.signal.aborted
      if (attempt < maxAttempts) {
        console.error(
          timedOut ? 'Groq image vision timeout, retrying:' : 'Groq image vision network error, retrying:',
          String(e).slice(0, 200),
        )
        if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs))
        continue
      }
      return {
        analysis: null,
        failure: {
          stage: timedOut ? 'groq_timeout' : 'groq_network_error',
          message: timedOut
            ? `Groq image vision timed out after ${boundedTimeoutMs}ms`
            : String(e).slice(0, 300),
        },
      }
    } finally {
      clearTimeout(timer)
    }

    if (response.ok) break

    const transient = response.status === 429 || response.status >= 500
    if (transient && attempt < maxAttempts) {
      const errBody = await response.text().catch(() => '')
      console.error('Groq image vision transient error, retrying:', response.status, errBody.slice(0, 200))
      if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs))
      continue
    }

    const err = await response.text()
    console.error('Groq image vision failed:', response.status, err)
    return {
      analysis: null,
      failure: {
        stage: 'groq_http_error',
        httpStatus: response.status,
        message: normalizeInlineText(err).slice(0, 500) || 'Groq API request failed.',
      },
    }
  }

  if (!response) {
    return { analysis: null, failure: { stage: 'groq_http_error', message: 'Groq API request failed.' } }
  }

  // response.ok でも本文が空/切断されていて JSON として不正な場合がある（Groq側の一過性障害）。
  // ここで例外を投げると呼び出し元まで伝播し「レシート処理中にエラーが発生しました」を返してしまうため、
  // 5xx/429 と同様に failure として扱う（未捕捉例外にしない）。
  // deno-lint-ignore no-explicit-any
  let json: any
  try {
    json = await response.json()
  } catch (e) {
    console.error('Groq image vision response JSON parse failed:', String(e).slice(0, 200))
    return {
      analysis: null,
      failure: { stage: 'groq_invalid_json', message: String(e).slice(0, 300) },
    }
  }
  const usage = extractGroqUsage(json)
  const content = String(json?.choices?.[0]?.message?.content ?? '').trim()
  if (!content) {
    return { analysis: null, failure: { stage: 'empty_model_content', message: 'Groq response content is empty.' }, usage }
  }

  const extracted = parseFirstJsonObject(content)
  if (extracted && typeof extracted === 'object') {
    const normalized = normalizeLineImageAnalysisResult(extracted as Record<string, unknown>)
    if (normalized) return { analysis: normalized, failure: null, usage }
  }

  const salvaged = salvageLineImageAnalysisResultFromText(content)
  if (salvaged) {
    return { analysis: salvaged, failure: null, usage }
  }

  const fallbackSummary = normalizeInlineText(content).slice(0, 240)
  if (!fallbackSummary) {
    return {
      analysis: null,
      failure: { stage: 'unparsable_model_output', message: 'Groq response could not be parsed.' },
      usage,
    }
  }
  return { analysis: { summary: fallbackSummary, receipt: null, receiptModelConfidence: null }, failure: null, usage }
}

/**
 * Azure AI Foundry の Responses API を使う標準レシート画像解析。
 * Azure は通常経路、Gemini は Azure 自体が失敗した場合だけの退避先として呼び出し側で使う。
 */
export async function analyzeLineImageWithAzureFoundry(
  bytes: Uint8Array,
  contentType: string | null,
  fileName: string,
  projectEndpoint: string,
  apiKey: string,
  deployment = AZURE_FOUNDRY_VISION_MODEL,
  systemPromptAddition = '',
  timeoutMs = 40000,
  retryDelayMs = 600,
): Promise<{ analysis: LineImageAnalysisResult | null; failure: LineImageVisionFailure | null; usage?: LineImageVisionUsage | null }> {
  if (!projectEndpoint || !apiKey) {
    return { analysis: null, failure: { stage: 'azure_foundry_missing_config', message: 'Azure Foundry endpoint or API key is missing.' } }
  }
  if (bytes.byteLength <= 0 || bytes.byteLength > GROQ_VISION_BASE64_MAX_BYTES) {
    return { analysis: null, failure: { stage: 'invalid_image_size', message: `Image bytes out of range: ${bytes.byteLength}` } }
  }
  const mime = String(contentType ?? '').trim().toLowerCase()
  if (!isVisionAnalyzableImageMime(mime)) {
    return { analysis: null, failure: { stage: 'unsupported_mime', message: `Unsupported image mime: ${mime || '(empty)'}` } }
  }

  const endpoint = `${projectEndpoint.replace(/\/+$/, '')}/openai/v1/responses`
  const body = JSON.stringify({
    model: deployment || AZURE_FOUNDRY_VISION_MODEL,
    instructions: buildReceiptVisionSystemPrompt(systemPromptAddition),
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: `この画像を解析してください。ファイル名: ${fileName || '(unknown)'}` },
        { type: 'input_image', image_url: `data:${mime};base64,${toBase64(bytes)}`, detail: 'high' },
      ],
    }],
    text: { format: { type: 'json_object' } },
    max_output_tokens: 1500,
  })

  const maxAttempts = 2
  let response: Response | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    const boundedTimeoutMs = Math.max(250, Math.min(timeoutMs, 60000))
    const timer = setTimeout(() => controller.abort(), boundedTimeoutMs)
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      })
    } catch (e) {
      const timedOut = controller.signal.aborted
      if (attempt < maxAttempts) {
        console.error(timedOut ? 'Azure Foundry image vision timeout, retrying:' : 'Azure Foundry image vision network error, retrying:', String(e).slice(0, 200))
        if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
        continue
      }
      return {
        analysis: null,
        failure: {
          stage: timedOut ? 'azure_foundry_timeout' : 'azure_foundry_network_error',
          message: timedOut ? `Azure Foundry image vision timed out after ${boundedTimeoutMs}ms` : String(e).slice(0, 300),
        },
      }
    } finally {
      clearTimeout(timer)
    }
    if (response.ok) break
    const transient = response.status === 429 || response.status >= 500
    if (transient && attempt < maxAttempts) {
      console.error('Azure Foundry image vision transient error, retrying:', response.status)
      if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
      continue
    }
    const err = await response.text().catch(() => '')
    console.error('Azure Foundry image vision failed:', response.status, normalizeInlineText(err).slice(0, 500))
    return {
      analysis: null,
      failure: {
        stage: 'azure_foundry_http_error',
        httpStatus: response.status,
        message: normalizeInlineText(err).slice(0, 500) || 'Azure Foundry API request failed.',
      },
    }
  }
  if (!response) return { analysis: null, failure: { stage: 'azure_foundry_http_error', message: 'Azure Foundry API request failed.' } }

  let json: unknown
  try {
    json = await response.json()
  } catch (e) {
    return { analysis: null, failure: { stage: 'azure_foundry_invalid_json', message: String(e).slice(0, 300) } }
  }
  const usage = extractAzureFoundryUsage(json)
  const content = extractAzureFoundryOutputText(json)
  if (!content) {
    return { analysis: null, failure: { stage: 'azure_foundry_empty_content', message: 'Azure Foundry response content is empty.' }, usage }
  }
  const extracted = parseFirstJsonObject(content)
  if (extracted && typeof extracted === 'object') {
    const normalized = normalizeLineImageAnalysisResult(extracted as Record<string, unknown>)
    if (normalized) return { analysis: normalized, failure: null, usage }
  }
  const salvaged = salvageLineImageAnalysisResultFromText(content)
  if (salvaged) return { analysis: salvaged, failure: null, usage }
  const fallbackSummary = normalizeInlineText(content).slice(0, 240)
  if (!fallbackSummary) {
    return { analysis: null, failure: { stage: 'azure_foundry_unparsable_model_output', message: 'Azure Foundry response could not be parsed.' }, usage }
  }
  return { analysis: { summary: fallbackSummary, receipt: null, receiptModelConfidence: null }, failure: null, usage }
}

function mergeVisionUsage(...items: Array<LineImageVisionUsage | null | undefined>): LineImageVisionUsage | null {
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  let thinkingTokens = 0
  let hasThinking = false
  let hasAny = false
  for (const item of items) {
    if (!item) continue
    hasAny = true
    inputTokens += item.inputTokens
    outputTokens += item.outputTokens
    totalTokens += item.totalTokens
    if (item.thinkingTokens != null) {
      hasThinking = true
      thinkingTokens += item.thinkingTokens
    }
  }
  return hasAny ? { inputTokens, outputTokens, totalTokens, thinkingTokens: hasThinking ? thinkingTokens : null } : null
}

function isCashOutLikeText(text: string): boolean {
  return /レジ出金|出金伝票|今回出金額|現金出金|小口出金/.test(text)
}

function isCashOutLikeAnalysis(analysis: LineImageAnalysisResult | null): boolean {
  if (!analysis?.receipt) return false
  const text = [
    analysis.summary ?? '',
    analysis.receipt.storeName ?? '',
    ...(analysis.receipt.items ?? []),
    ...((analysis.receipt.lineItems ?? []).map((it) => String(it?.name ?? '').trim()).filter(Boolean)),
  ].join(' ')
  return isCashOutLikeText(text)
}

function buildExpenseIgnoreCashOutPrompt(
  basePromptAddition: string,
  analysis: LineImageAnalysisResult,
): string {
  const lines = [
    String(basePromptAddition || '').trim(),
    '【再確認・複数伝票対策】画像に複数の紙が写っている場合、店舗自身の「レジ出金」「今回出金額」「出金伝票」「仕入食材」「消耗品」などの紙は完全に無視してください。',
    '【最重要】store_name・line_items・税率は、必ず仕入先の領収書/レシート側だけから読み直してください。レジ出金伝票の科目名を商品名に使ってはいけません。',
  ]
  const storeName = String(analysis.receipt?.storeName || '').trim()
  if (storeName && !isCashOutLikeText(storeName)) {
    lines.push(`【今回の集中対象】仕入先は「${storeName}」側の紙です。この紙の店名・商品名・税率だけを優先して再抽出してください。`)
  }
  const storePhone = String(analysis.receipt?.storePhone || '').trim()
  if (storePhone) {
    lines.push(`【補助手がかり】電話番号「${storePhone}」が見える紙があれば、その紙を仕入先レシートとして優先してください。`)
  }
  return lines.filter(Boolean).join('\n')
}

function scoreExpenseReceiptAnalysis(result: { analysis: LineImageAnalysisResult | null; failure: LineImageVisionFailure | null }): number {
  const analysis = result.analysis
  const receipt = analysis?.receipt
  if (!analysis || !receipt) return -100
  const lineItemCount = Array.isArray(receipt.lineItems) ? receipt.lineItems.filter((it) => String(it?.name ?? '').trim()).length : 0
  const itemCount = Array.isArray(receipt.items) ? receipt.items.filter((v) => String(v ?? '').trim()).length : 0
  const summaryText = [
    analysis.summary ?? '',
    receipt.storeName ?? '',
    ...(receipt.items ?? []),
    ...((receipt.lineItems ?? []).map((it) => String(it?.name ?? '').trim()).filter(Boolean)),
  ].join(' ')
  let score = 20
  if (receipt.storeName) score += 6
  if (receipt.grossSales || receipt.netSales) score += 4
  if (receipt.taxAmount) score += 2
  if (receipt.taxBreakdown?.length) score += 6
  score += lineItemCount * 4
  score += itemCount
  if (isCashOutLikeText(summaryText)) score -= 30
  if (lineItemCount === 0 && itemCount === 0) score -= 8
  return score
}

function mergeExpenseReceiptAnalyses(
  base: LineImageAnalysisResult,
  detail: LineImageAnalysisResult,
): LineImageAnalysisResult {
  if (!base.receipt) return detail
  if (!detail.receipt) return base
  return {
    summary: detail.summary || base.summary,
    receiptModelConfidence: Math.max(base.receiptModelConfidence ?? 0, detail.receiptModelConfidence ?? 0),
    reservation: detail.reservation ?? base.reservation ?? null,
    receipt: {
      storeName: detail.receipt.storeName || base.receipt.storeName,
      storePhone: detail.receipt.storePhone || base.receipt.storePhone,
      date: detail.receipt.date || base.receipt.date,
      netSales: detail.receipt.netSales || base.receipt.netSales,
      taxAmount: detail.receipt.taxAmount || base.receipt.taxAmount,
      grossSales: detail.receipt.grossSales || base.receipt.grossSales,
      partyCount: detail.receipt.partyCount || base.receipt.partyCount,
      guestCount: detail.receipt.guestCount || base.receipt.guestCount,
      unitPrice: detail.receipt.unitPrice || base.receipt.unitPrice,
      items: (detail.receipt.items?.length ? detail.receipt.items : base.receipt.items) ?? [],
      lineItems: detail.receipt.lineItems?.length ? detail.receipt.lineItems : base.receipt.lineItems,
      taxBreakdown: detail.receipt.taxBreakdown?.length ? detail.receipt.taxBreakdown : base.receipt.taxBreakdown,
    },
  }
}

export async function analyzeExpenseReceiptWithGroqScout(
  bytes: Uint8Array,
  contentType: string | null,
  fileName: string,
  groqApiKey: string,
  systemPromptAddition = '',
): Promise<{ analysis: LineImageAnalysisResult | null; failure: LineImageVisionFailure | null; usage?: LineImageVisionUsage | null }> {
  const full = await analyzeLineImageWithGroqScout(bytes, contentType, fileName, groqApiKey, systemPromptAddition)
  if (!full.analysis?.receipt) return full

  const focused = await analyzeLineImageWithGroqScout(
    bytes,
    contentType,
    `${fileName || 'receipt'}#focused`,
    groqApiKey,
    buildExpenseIgnoreCashOutPrompt(systemPromptAddition, full.analysis),
  )
  const combinedUsage = mergeVisionUsage(full.usage, focused.usage)
  if (!focused.analysis) return { ...full, usage: combinedUsage ?? full.usage }

  const fullScore = isCashOutLikeAnalysis(full.analysis) ? -1000 : scoreExpenseReceiptAnalysis(full)
  const focusedScore = isCashOutLikeAnalysis(focused.analysis) ? -1000 : scoreExpenseReceiptAnalysis(focused)
  if (focusedScore <= fullScore + 1) return { ...full, usage: combinedUsage ?? full.usage }

  return {
    analysis: mergeExpenseReceiptAnalyses(full.analysis, focused.analysis),
    failure: null,
    usage: combinedUsage ?? focused.usage,
  }
}

/** Azure Foundry を使う小口・経費向けの二段階再解析。 */
export async function analyzeExpenseReceiptWithAzureFoundry(
  bytes: Uint8Array,
  contentType: string | null,
  fileName: string,
  projectEndpoint: string,
  apiKey: string,
  deployment = AZURE_FOUNDRY_VISION_MODEL,
  systemPromptAddition = '',
): Promise<{ analysis: LineImageAnalysisResult | null; failure: LineImageVisionFailure | null; usage?: LineImageVisionUsage | null }> {
  const full = await analyzeLineImageWithAzureFoundry(
    bytes, contentType, fileName, projectEndpoint, apiKey, deployment, systemPromptAddition,
  )
  if (!full.analysis?.receipt) return full
  const focused = await analyzeLineImageWithAzureFoundry(
    bytes,
    contentType,
    `${fileName || 'receipt'}#focused`,
    projectEndpoint,
    apiKey,
    deployment,
    buildExpenseIgnoreCashOutPrompt(systemPromptAddition, full.analysis),
  )
  const combinedUsage = mergeVisionUsage(full.usage, focused.usage)
  if (!focused.analysis) return { ...full, usage: combinedUsage ?? full.usage }

  const fullScore = isCashOutLikeAnalysis(full.analysis) ? -1000 : scoreExpenseReceiptAnalysis(full)
  const focusedScore = isCashOutLikeAnalysis(focused.analysis) ? -1000 : scoreExpenseReceiptAnalysis(focused)
  if (focusedScore <= fullScore + 1) return { ...full, usage: combinedUsage ?? full.usage }
  return {
    analysis: mergeExpenseReceiptAnalyses(full.analysis, focused.analysis),
    failure: null,
    usage: combinedUsage ?? focused.usage,
  }
}

function extractTextFromGeminiResponse(payload: unknown): string {
  const candidates = (payload as { candidates?: unknown })?.candidates
  const list = Array.isArray(candidates) ? candidates : []
  const parts: string[] = []
  for (const candidate of list) {
    const contentParts = (candidate as { content?: { parts?: unknown } })?.content?.parts
    const partList = Array.isArray(contentParts) ? contentParts : []
    for (const part of partList) {
      const text = (part as { text?: unknown })?.text
      if (typeof text === 'string' && text.trim()) parts.push(text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Gemini（Google Generative Language API）でレシート画像を解析する。
 * 戻り値は analyzeLineImageWithGroqScout と同型なので、呼び出し側は差し替えるだけでよい。
 * 失敗（キー無し/HTTP/空/解析不能/タイムアウト）時は failure を返し、呼び出し側で Groq へフォールバックできる。
 */
export async function analyzeLineImageWithGemini(
  bytes: Uint8Array,
  contentType: string | null,
  fileName: string,
  geminiApiKey: string,
  systemPromptAddition = '',
  model = 'gemini-3.1-pro-preview',
  timeoutMs = 30000,
): Promise<{ analysis: LineImageAnalysisResult | null; failure: LineImageVisionFailure | null; usage?: LineImageVisionUsage | null }> {
  if (!geminiApiKey) {
    return { analysis: null, failure: { stage: 'missing_api_key', message: 'GEMINI_API_KEY is missing.' } }
  }
  if (bytes.byteLength <= 0 || bytes.byteLength > GROQ_VISION_BASE64_MAX_BYTES) {
    return {
      analysis: null,
      failure: { stage: 'invalid_image_size', message: `Image bytes out of range: ${bytes.byteLength}` },
    }
  }
  const mime = String(contentType ?? '').trim().toLowerCase()
  if (!isVisionAnalyzableImageMime(mime)) {
    return {
      analysis: null,
      failure: { stage: 'unsupported_mime', message: `Unsupported image mime: ${mime || '(empty)'}` },
    }
  }

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
  const body = {
    system_instruction: { parts: [{ text: buildReceiptVisionSystemPrompt(systemPromptAddition) }] },
    contents: [
      {
        role: 'user',
        parts: [
          { text: `この画像を解析してください。ファイル名: ${fileName || '(unknown)'}` },
          { inline_data: { mime_type: mime, data: toBase64(bytes) } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      // Gemini 3.x Pro は思考型のため、思考トークンで本出力が枯渇しないよう余裕を持たせる
      // （枯渇すると空応答→Groqへ無言フォールバックになり精度が落ちる）。
      maxOutputTokens: 16384,
      responseMimeType: 'application/json',
    },
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': geminiApiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError'
    return {
      analysis: null,
      failure: {
        stage: aborted ? 'gemini_timeout' : 'gemini_network_error',
        message: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      },
    }
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    const err = await response.text().catch(() => '')
    console.error('Gemini image vision failed:', model, response.status, err.slice(0, 500))
    return {
      analysis: null,
      failure: {
        stage: 'gemini_http_error',
        httpStatus: response.status,
        message: normalizeInlineText(err).slice(0, 500) || 'Gemini API request failed.',
      },
    }
  }

  const json = await response.json().catch(() => null)
  const usage = extractGeminiUsage(json)
  const content = extractTextFromGeminiResponse(json)
  if (!content) {
    const finishReason = String(
      (json as { candidates?: Array<{ finishReason?: unknown }> })?.candidates?.[0]?.finishReason ?? '',
    )
    console.error('Gemini image vision empty content:', model, 'finishReason=', finishReason)
    return { analysis: null, failure: { stage: 'gemini_empty_content', message: `Gemini response content is empty (finishReason=${finishReason}).` }, usage }
  }

  const extracted = parseFirstJsonObject(content)
  if (extracted && typeof extracted === 'object') {
    const normalized = normalizeLineImageAnalysisResult(extracted as Record<string, unknown>)
    if (normalized) return { analysis: normalized, failure: null, usage }
  }

  const salvaged = salvageLineImageAnalysisResultFromText(content)
  if (salvaged) return { analysis: salvaged, failure: null, usage }

  const fallbackSummary = normalizeInlineText(content).slice(0, 240)
  if (!fallbackSummary) {
    return {
      analysis: null,
      failure: { stage: 'unparsable_model_output', message: 'Gemini response could not be parsed.' },
      usage,
    }
  }
  return { analysis: { summary: fallbackSummary, receipt: null, receiptModelConfidence: null }, failure: null, usage }
}

function extractTextFromClaudeResponse(payload: unknown): string {
  const content = (payload as { content?: unknown })?.content
  const list = Array.isArray(content) ? content : []
  const parts: string[] = []
  for (const block of list) {
    const b = block as { type?: unknown; text?: unknown }
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text)
  }
  return parts.join('\n').trim()
}

function extractClaudeUsage(payload: unknown): LineImageVisionUsage | null {
  const u = (payload as { usage?: unknown })?.usage as { input_tokens?: unknown; output_tokens?: unknown } | undefined
  if (!u) return null
  const input = Number(u.input_tokens ?? 0) || 0
  const output = Number(u.output_tokens ?? 0) || 0
  return { inputTokens: input, outputTokens: output, thinkingTokens: null, totalTokens: input + output }
}

/**
 * Anthropic Claude（vision）でレシート画像を解析する。
 * 戻り値は analyzeLineImageWithGroqScout / analyzeLineImageWithGemini と同型なので、呼び出し側は差し替えるだけでよい。
 * 失敗（キー無し/HTTP/空/解析不能/タイムアウト）時は failure を返し、呼び出し側で Groq へフォールバックできる。
 */
export async function analyzeLineImageWithClaude(
  bytes: Uint8Array,
  contentType: string | null,
  fileName: string,
  anthropicApiKey: string,
  systemPromptAddition = '',
  model = 'claude-haiku-4-5',
  timeoutMs = 30000,
): Promise<{ analysis: LineImageAnalysisResult | null; failure: LineImageVisionFailure | null; usage?: LineImageVisionUsage | null }> {
  if (!anthropicApiKey) {
    return { analysis: null, failure: { stage: 'missing_api_key', message: 'Anthropic API key (claude_haiku) is missing.' } }
  }
  if (bytes.byteLength <= 0 || bytes.byteLength > GROQ_VISION_BASE64_MAX_BYTES) {
    return { analysis: null, failure: { stage: 'invalid_image_size', message: `Image bytes out of range: ${bytes.byteLength}` } }
  }
  const mime = String(contentType ?? '').trim().toLowerCase()
  if (!isVisionAnalyzableImageMime(mime)) {
    return { analysis: null, failure: { stage: 'unsupported_mime', message: `Unsupported image mime: ${mime || '(empty)'}` } }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        // 経費(line_items)の明細つきJSONは1024だと途中切断され、品目が毎回5〜6個で
        // 打ち切られる実害が出た（2026-06-11 TOBU 8品）。上限であり実出力分のみ課金。
        max_tokens: 4096,
        system: buildReceiptVisionSystemPrompt(systemPromptAddition),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mime, data: toBase64(bytes) } },
              { type: 'text', text: `この画像を解析し、指定のJSONだけを返してください（前後に文章やコードブロックを付けない）。ファイル名: ${fileName || '(unknown)'}` },
            ],
          },
        ],
      }),
    })
  } catch (e) {
    clearTimeout(timer)
    const aborted = (e as { name?: string })?.name === 'AbortError'
    return {
      analysis: null,
      failure: {
        stage: aborted ? 'claude_timeout' : 'claude_fetch_error',
        message: aborted ? `Claude request timed out after ${timeoutMs}ms` : String(e).slice(0, 300),
      },
    }
  }
  clearTimeout(timer)

  if (!response.ok) {
    const err = await response.text()
    console.error('Claude image vision failed:', response.status, err.slice(0, 500))
    return {
      analysis: null,
      failure: {
        stage: 'claude_http_error',
        httpStatus: response.status,
        message: normalizeInlineText(err).slice(0, 500) || 'Anthropic API request failed.',
      },
    }
  }

  // deno-lint-ignore no-explicit-any
  let json: any
  try {
    json = await response.json()
  } catch (e) {
    console.error('Claude image vision response JSON parse failed:', String(e).slice(0, 200))
    return {
      analysis: null,
      failure: { stage: 'claude_invalid_json', message: String(e).slice(0, 300) },
    }
  }
  const usage = extractClaudeUsage(json)
  const content = extractTextFromClaudeResponse(json)
  if (!content) {
    return { analysis: null, failure: { stage: 'claude_empty_content', message: 'Claude response content is empty.' }, usage }
  }

  const extracted = parseFirstJsonObject(content)
  if (extracted && typeof extracted === 'object') {
    const normalized = normalizeLineImageAnalysisResult(extracted as Record<string, unknown>)
    if (normalized) return { analysis: normalized, failure: null, usage }
  }
  const salvaged = salvageLineImageAnalysisResultFromText(content)
  if (salvaged) return { analysis: salvaged, failure: null, usage }

  const fallbackSummary = normalizeInlineText(content).slice(0, 240)
  if (!fallbackSummary) {
    return { analysis: null, failure: { stage: 'unparsable_model_output', message: 'Claude response could not be parsed.' }, usage }
  }
  return { analysis: { summary: fallbackSummary, receipt: null, receiptModelConfidence: null }, failure: null, usage }
}
