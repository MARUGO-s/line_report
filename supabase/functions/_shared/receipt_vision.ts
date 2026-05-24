import type { LineImageAnalysisResult, LineImageVisionFailure } from './receipt_types.ts'
import { GROQ_VISION_BASE64_MAX_BYTES } from './receipt_types.ts'
import {
  normalizeInlineText,
  normalizeLineImageAnalysisResult,
  parseFirstJsonObject,
} from './receipt_parse.ts'

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
      temperature: 0.1,
      max_tokens: 380,
      messages: [
        {
          role: 'system',
          content: [
            'あなたは画像解析アシスタントです。必ず JSON のみを返してください（説明文・コードブロック禁止）。',
            '画像が横向き・逆向きの場合は、頭の中で正立に回転してから読むこと。',
            '画像がレシート/領収書なら kind を receipt にし、主要項目を抽出してください。',
            'レシートでない場合は kind を general にし、summary に1文（80文字以内）で内容を入れてください。',
            'JSONスキーマ:',
            '{"kind":"receipt|general","summary":"string","receipt_confidence":0.0,"receipt":{"store_name":"string|null","store_phone":"string|null","date":"string|null","net_sales":"string|null","tax_amount":"string|null","gross_sales":"string|null","party_count":"string|null","guest_count":"string|null","unit_price":"string|null","items":["string"]}}',
            'store_phone はレシート上部の電話番号（例: 03-5361-6205）。読めない場合は null。',
            'receipt は kind=general の時は null でも可。items は最大5件まで。読めない項目は null。',
            'kind=receipt のときは receipt_confidence に 0.0〜1.0 の数値を必ず入れる。',
            '金額は可能なら「¥7,700」の形式。会計組数・客数は数値として抽出。summary は必須。',
          ].join('\n'),
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

  const fallbackSummary = normalizeInlineText(content).slice(0, 240)
  if (!fallbackSummary) {
    return {
      analysis: null,
      failure: { stage: 'unparsable_model_output', message: 'Groq response could not be parsed.' },
    }
  }
  return { analysis: { summary: fallbackSummary, receipt: null, receiptModelConfidence: null }, failure: null }
}
