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

export async function analyzeLineImageWithGroqScout(
  bytes: Uint8Array,
  contentType: string | null,
  fileName: string,
  groqApiKey: string,
  systemPromptAddition = '',
): Promise<{ analysis: LineImageAnalysisResult | null; failure: LineImageVisionFailure | null }> {
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
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${groqApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 380,
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
    }),
  })

  if (!response.ok) {
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

  const json = await response.json()
  const content = String(json?.choices?.[0]?.message?.content ?? '').trim()
  if (!content) {
    return { analysis: null, failure: { stage: 'empty_model_content', message: 'Groq response content is empty.' } }
  }

  const extracted = parseFirstJsonObject(content)
  if (extracted && typeof extracted === 'object') {
    const normalized = normalizeLineImageAnalysisResult(extracted as Record<string, unknown>)
    if (normalized) return { analysis: normalized, failure: null }
  }

  const salvaged = salvageLineImageAnalysisResultFromText(content)
  if (salvaged) {
    return { analysis: salvaged, failure: null }
  }

  const fallbackSummary = normalizeInlineText(content).slice(0, 240)
  if (!fallbackSummary) {
    return {
      analysis: null,
      failure: { stage: 'unparsable_model_output', message: 'Groq response could not be parsed.' },
    }
  }
  return { analysis: { summary: fallbackSummary, receipt: null, receiptModelConfidence: null }, failure: null }
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
): Promise<{ analysis: LineImageAnalysisResult | null; failure: LineImageVisionFailure | null }> {
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
  const content = extractTextFromGeminiResponse(json)
  if (!content) {
    const finishReason = String(
      (json as { candidates?: Array<{ finishReason?: unknown }> })?.candidates?.[0]?.finishReason ?? '',
    )
    console.error('Gemini image vision empty content:', model, 'finishReason=', finishReason)
    return { analysis: null, failure: { stage: 'gemini_empty_content', message: `Gemini response content is empty (finishReason=${finishReason}).` } }
  }

  const extracted = parseFirstJsonObject(content)
  if (extracted && typeof extracted === 'object') {
    const normalized = normalizeLineImageAnalysisResult(extracted as Record<string, unknown>)
    if (normalized) return { analysis: normalized, failure: null }
  }

  const salvaged = salvageLineImageAnalysisResultFromText(content)
  if (salvaged) return { analysis: salvaged, failure: null }

  const fallbackSummary = normalizeInlineText(content).slice(0, 240)
  if (!fallbackSummary) {
    return {
      analysis: null,
      failure: { stage: 'unparsable_model_output', message: 'Gemini response could not be parsed.' },
    }
  }
  return { analysis: { summary: fallbackSummary, receipt: null, receiptModelConfidence: null }, failure: null }
}
