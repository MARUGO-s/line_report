// Groq text-model selection shared by delivery and analysis flows.
// Keep old secret values from reviving models that Groq has retired.
export const GROQ_TEXT_PRIMARY_MODEL = 'openai/gpt-oss-120b'
export const GROQ_TEXT_FALLBACK_MODEL = 'qwen/qwen3.6-27b'

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
