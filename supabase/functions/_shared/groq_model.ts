// Groq text-model selection shared by delivery and analysis flows.
// Keep old secret values from reviving models that Groq has retired.
export const GROQ_TEXT_PRIMARY_MODEL = 'openai/gpt-oss-120b'
// フォールバックは本番安定枠に固定する（qwen/qwen3.6-27b は Groq 上で preview 相当のため text の
// 二次系には使わない。qwen は receipt_vision の GROQ_VISION_MODEL 側でのみ継続利用）。
export const GROQ_TEXT_FALLBACK_MODEL = 'openai/gpt-oss-120b'
// フードコート専門AI①（数値/他店比較）のプロバイダ多様性用モデル（Moonshot Kimi K2, 非OpenAI系）。
// FOODCOURT_GROQ_MODEL 未設定時の既定値としても使えるよう定数化しておく。
export const GROQ_TEXT_KIMI_MODEL = 'moonshotai/kimi-k2-instruct-0905'

const RETIRED_GROQ_TEXT_MODELS = new Set([
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'qwen/qwen3-32b',
])

export function resolveGroqTextModel(value: string | null | undefined, fallback = GROQ_TEXT_PRIMARY_MODEL): string {
  const model = String(value ?? '').trim()
  if (!model || RETIRED_GROQ_TEXT_MODELS.has(model.toLowerCase())) return fallback
  return model
}
