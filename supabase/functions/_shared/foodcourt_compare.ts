// フードコート「テナント一覧」レポート（v2.mallpro.jp）の自動解析（分析専用・売上には登録しない）。
// マルゴS等フードコート内店舗が毎日送る全テナントの売上/客数を抽出し、基準店=100の比較カードを返す。
// 安全策: ①対象店舗を限定（FOODCOURT_STORE_KEYS）②マーカー判定 ③抽出が表として成立しなければ未処理を返し
//   通常のレシート処理へフォールスルー（誤検知が売上に影響しない）。
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import { issueAdminDashboardLoginLinkToken } from './admin_dashboard_link_auth.ts'

// LINE通知から開くフードコート分析ページ（本番）。小口現金と同方式: from=line＋store_key＋ワンタイム lt。
const FOODCOURT_PAGE_BASE = 'https://marugo-s.github.io/line_report/foodcourt.html'
const FOODCOURT_URI_MAX_LEN = 1000

function buildFoodCourtPageUrl(storeKey: string, loginToken?: string | null): string {
  const key = String(storeKey || '').trim()
  const lt = String(loginToken ?? '').trim()
  if (lt) {
    const withToken = `${FOODCOURT_PAGE_BASE}?${new URLSearchParams({ store_key: key, from: 'line', lt }).toString()}`
    if (withToken.length <= FOODCOURT_URI_MAX_LEN) return withToken
  }
  return `${FOODCOURT_PAGE_BASE}?${new URLSearchParams({ store_key: key, from: 'line' }).toString()}`
}

async function buildFoodCourtDashboardLink(supabase: SupabaseClient, storeKey: string): Promise<string> {
  const key = String(storeKey || '').trim()
  if (!key) return ''
  try {
    const issued = await issueAdminDashboardLoginLinkToken(supabase, { source: 'line_foodcourt', store_partition_key: key })
    return buildFoodCourtPageUrl(key, issued.token)
  } catch (e) {
    console.error('buildFoodCourtDashboardLink failed:', e instanceof Error ? e.message : String(e))
    return buildFoodCourtPageUrl(key, null)
  }
}

// フードコートレポートを送ってくる店舗（基準店）。baseTenantName=比較の基準、expectedTenants=想定テナント数(Groq抽出の十分性判定用)。
export const FOODCOURT_STORE_KEYS: Record<string, { baseTenantName: string; expectedTenants?: number }> = {
  marugoS: { baseTenantName: 'MARUGO S', expectedTenants: 11 },
}

// フードコート一覧らしさのマーカー（テナント表＝全テナントの対象/比較 売上・客数が並ぶ）。
const FOODCOURT_MARKERS =
  /テナント|対象売上|比較売上|売上比率|客数比率|対象客数|比較客数|mallpro|5092\d{3}/i

export type FoodCourtTenant = {
  name: string
  code: string | null
  sales: number | null
  guests: number | null
  /** 比較売上（前年/前期）。比較分析用。読めなければ null。 */
  compSales?: number | null
  /** 比較客数（前年/前期）。 */
  compGuests?: number | null
}

export function looksLikeFoodCourtReport(text: string): boolean {
  return FOODCOURT_MARKERS.test(String(text ?? ''))
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function parseFirstJson(text: string): Record<string, unknown> | null {
  const s = text.indexOf('{')
  const e = text.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  try {
    const o = JSON.parse(text.slice(s, e + 1))
    return (o && typeof o === 'object') ? o as Record<string, unknown> : null
  } catch {
    return null
  }
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null
  const n = Number(String(v).replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? Math.round(n) : null
}

// ===== AI使用量の記録 =====
// フードコートのAI（Q&A=Groqチャット／テナント表の画像抽出=Groq/Gemini Vision）の実測トークンを
// ai_usage_events に1行記録し、AI使用料ページ（/usage/ai-cost＝実測トークン×公式単価）に反映させる。
export interface FoodCourtAiUsage {
  provider: 'groq' | 'gemini' | 'claude'
  model: string
  inputTokens: number
  outputTokens: number
  thinkingTokens: number | null
  totalTokens: number
}
function groqUsageFrom(json: unknown, model: string): FoodCourtAiUsage | null {
  const u = (json && typeof json === 'object') ? (json as { usage?: unknown }).usage : null
  if (!u || typeof u !== 'object') return null
  const m = u as Record<string, unknown>
  const inp = Number(m.prompt_tokens ?? 0) || 0
  const out = Number(m.completion_tokens ?? 0) || 0
  const tot = Number(m.total_tokens ?? 0) || (inp + out)
  if (!inp && !out && !tot) return null
  return { provider: 'groq', model, inputTokens: inp, outputTokens: out, thinkingTokens: null, totalTokens: tot }
}
function geminiUsageFrom(json: unknown, model: string): FoodCourtAiUsage | null {
  const u = (json && typeof json === 'object') ? (json as { usageMetadata?: unknown }).usageMetadata : null
  if (!u || typeof u !== 'object') return null
  const m = u as Record<string, unknown>
  const inp = Number(m.promptTokenCount ?? 0) || 0
  const out = Number(m.candidatesTokenCount ?? 0) || 0
  const th = m.thoughtsTokenCount != null ? (Number(m.thoughtsTokenCount) || 0) : null
  const tot = Number(m.totalTokenCount ?? 0) || (inp + out + (th ?? 0))
  if (!inp && !out && !tot) return null
  return { provider: 'gemini', model, inputTokens: inp, outputTokens: out, thinkingTokens: th, totalTokens: tot }
}
async function recordFoodCourtAiUsage(
  supabase: SupabaseClient | null | undefined,
  storeKey: string,
  lineMessageId: string | null,
  usage: FoodCourtAiUsage | null,
): Promise<void> {
  if (!supabase || !storeKey || !usage) return
  try {
    const { error } = await supabase.from('ai_usage_events').insert({
      store_partition_key: storeKey,
      provider: usage.provider,
      model: usage.model,
      input_tokens: usage.inputTokens || 0,
      output_tokens: usage.outputTokens || 0,
      thinking_tokens: usage.thinkingTokens,
      total_tokens: usage.totalTokens || 0,
      line_message_id: lineMessageId,
      surface: 'foodcourt', // 用途タグ: フードコート分析(Q&A・テナント表画像抽出)。レシート解析と区別する。
    })
    if (error) console.error('foodcourt ai_usage_events insert failed:', error.message)
  } catch (e) {
    console.error('foodcourt ai_usage_events insert threw:', (e instanceof Error ? e.message : String(e)).slice(0, 200))
  }
}

function tenantsFromParsed(parsed: Record<string, unknown> | null): FoodCourtTenant[] | null {
  const rawList = parsed && Array.isArray(parsed.tenants) ? parsed.tenants : null
  if (!rawList) return null
  const tenants: FoodCourtTenant[] = []
  for (const r of rawList) {
    const o = (r && typeof r === 'object') ? r as Record<string, unknown> : {}
    const name = String(o.name ?? '').trim()
    if (!name) continue
    const code = o.code != null ? String(o.code).replace(/[^\d]/g, '').slice(0, 12) || null : null
    // OCR誤読対策: 安定codeがあれば正規店名へ寄せ、無ければ既知エイリアスを補正してから保存する。
    const canonName = (code && FC_CODE_TO_NAME[code]) ? FC_CODE_TO_NAME[code] : (FC_NAME_ALIASES[name] || name)
    tenants.push({
      name: canonName.slice(0, 60),
      code,
      sales: numOrNull(o.sales),
      guests: numOrNull(o.guests),
      compSales: numOrNull(o.comp_sales),
      compGuests: numOrNull(o.comp_guests),
    })
  }
  return tenants.length ? tenants : null
}

const EXTRACT_PROMPT = [
  'この画像はフードコートの「テナント一覧」売上レポート（各テナントの対象売上・比較売上・対象客数などが行で並ぶ表）です。',
  '表の**全テナント行**を抜き出して、JSONだけを返してください（前後に文章を付けない）。',
  '各行: name=テナント名（印字どおり）, code=テナントコード（数字。無ければnull）, sales=「対象売上」, guests=「対象客数」, comp_sales=「比較売上」, comp_guests=「比較客数」。',
  '数値はカンマ・¥・%・空白を除いた整数にする。「売上比率」「客数比率」の%列は出さなくてよい（システムが計算する）。読めない数値はnull。比較売上が0や空欄なら comp_sales=0 とする。',
  '出力形式: {"tenants":[{"name":"店名","code":"5092133","sales":496838,"guests":265,"comp_sales":620196,"comp_guests":318}, ...]}',
].join('\n')

// 自己完結の Gemini Vision 呼び出し（テナント表を JSON 抽出）。レシート用スキーマには依存しない。
export async function extractFoodCourtTenants(
  bytes: Uint8Array,
  contentType: string | null,
  geminiApiKey: string,
  model: string,
  timeoutMs = 30000,
  onUsage?: (u: FoodCourtAiUsage) => void,
): Promise<FoodCourtTenant[] | null> {
  if (!geminiApiKey || !bytes || bytes.byteLength <= 0) return null
  const mime = String(contentType ?? '').trim().toLowerCase()
  if (!/^image\/(png|jpe?g|webp|gif|heic|heif)$/.test(mime)) return null

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
  const body = {
    contents: [
      { role: 'user', parts: [{ text: EXTRACT_PROMPT }, { inline_data: { mime_type: mime, data: toBase64(bytes) } }] },
    ],
    generationConfig: { temperature: 0.1, maxOutputTokens: 16384, responseMimeType: 'application/json' },
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiApiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (e) {
    console.error('extractFoodCourtTenants fetch failed:', e instanceof Error ? e.message : String(e))
    return null
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    console.error('extractFoodCourtTenants http error:', res.status)
    return null
  }
  const json = await res.json().catch(() => null) as
    | { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
    | null
  if (onUsage) { const u = geminiUsageFrom(json, model); if (u) onUsage(u) }
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p?.text ?? '').join('') ?? ''
  return tenantsFromParsed(parseFirstJson(text))
}

// 安価な Groq(llama-4-scout) で抽出（印字されたクリーンな表向け）。失敗時は呼び出し側で Gemini にフォールバック。
export async function extractFoodCourtTenantsGroq(
  bytes: Uint8Array,
  contentType: string | null,
  groqApiKey: string,
  timeoutMs = 25000,
  onUsage?: (u: FoodCourtAiUsage) => void,
): Promise<FoodCourtTenant[] | null> {
  if (!groqApiKey || !bytes || bytes.byteLength <= 0) return null
  const mime = String(contentType ?? '').trim().toLowerCase()
  if (!/^image\/(png|jpe?g|webp|gif)$/.test(mime)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 2000,
        messages: [
          { role: 'system', content: EXTRACT_PROMPT },
          { role: 'user', content: [
            { type: 'text', text: 'このフードコートのテナント一覧表を全行JSONで抽出してください。' },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${toBase64(bytes)}` } },
          ] },
        ],
      }),
      signal: controller.signal,
    })
  } catch (e) {
    console.error('extractFoodCourtTenantsGroq fetch failed:', e instanceof Error ? e.message : String(e))
    return null
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) { console.error('extractFoodCourtTenantsGroq http error:', res.status); return null }
  const json = await res.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }>; usage?: unknown } | null
  if (onUsage) { const u = groqUsageFrom(json, 'meta-llama/llama-4-scout-17b-16e-instruct'); if (u) onUsage(u) }
  const content = String(json?.choices?.[0]?.message?.content ?? '')
  return tenantsFromParsed(parseFirstJson(content))
}

export type FoodCourtComparison = {
  baseName: string
  baseSales: number
  baseGuests: number
  baseUnit: number | null
  totalSales: number
  baseSharePct: number | null
  salesRank: number
  guestRank: number
  unitRank: number
  count: number
  rows: Array<{ name: string; sales: number | null; salesRatio: number | null; guests: number | null; unit: number | null }>
}

const yen = (v: number) => '¥' + Math.round(v).toLocaleString('ja-JP')
const pct1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1) + '%'
const unitOf = (t: FoodCourtTenant) => (t.sales != null && t.guests && t.guests > 0) ? t.sales / t.guests : null

// 基準店=100 の比較を計算（売上が読めたテナントのみ対象）。
export function computeFoodCourtComparison(tenants: FoodCourtTenant[], baseName: string): FoodCourtComparison | null {
  const valid = tenants.filter((t) => t.sales != null && t.sales >= 0)
  if (valid.length < 2) return null
  const base = valid.find((t) => normalizeName(t.name) === normalizeName(baseName))
  if (!base || base.sales == null) return null
  const baseSales = base.sales
  const baseGuests = base.guests ?? 0
  const baseUnit = unitOf(base)
  const totalSales = valid.reduce((a, b) => a + (b.sales ?? 0), 0)
  const salesRank = 1 + valid.filter((t) => (t.sales ?? 0) > baseSales).length
  const guestRank = 1 + valid.filter((t) => (t.guests ?? 0) > baseGuests).length
  const unitRank = baseUnit == null ? 0 : 1 + valid.filter((t) => { const u = unitOf(t); return u != null && u > baseUnit }).length
  const rows = valid
    .map((t) => ({
      name: t.name,
      sales: t.sales,
      salesRatio: (t.sales != null && baseSales > 0) ? (t.sales / baseSales) * 100 : null,
      guests: t.guests,
      unit: unitOf(t),
    }))
    .sort((a, b) => (b.sales ?? 0) - (a.sales ?? 0))
  return {
    baseName: base.name,
    baseSales,
    baseGuests,
    baseUnit,
    totalSales,
    baseSharePct: totalSales > 0 ? (baseSales / totalSales) * 100 : null,
    salesRank,
    guestRank,
    unitRank,
    count: valid.length,
    rows,
  }
}

function normalizeName(s: string): string {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '')
}

// FOOD STADIUM TOKYO の安定POSコード→正規店名。OCRで name が誤読（獺月/蟬月/パインセオ/ビアー等）でも
// code で同定して正しい11店に寄せる。店舗数が11を超えて分析がブレるのを防ぐ。code未知は名前を尊重。
const FC_CODE_TO_NAME: Record<string, string> = {
  '5092133': 'クラフトビアマーケット', '5092134': 'ベトナム屋台バインセオサイゴン', '5092135': '新御茶ノ水 萬龍',
  '5092136': 'ニュー大金星', '5092137': 'A destra Salvatore', '5092138': '蟻月', '5092139': 'チャルモゴッソヨ',
  '5092140': 'ラーメン＆酒バル 麺屋一燈', '5092141': '台湾点心とビール 恒久飯店', '5092143': '水道橋 すしわさび', '5092162': 'MARUGO S',
}
const FC_NAME_ALIASES: Record<string, string> = {
  'クラフトビアーマーケット': 'クラフトビアマーケット', 'チャルモゴッツォヨ': 'チャルモゴッソヨ',
  'ベトナム屋台パインセオサイゴン': 'ベトナム屋台バインセオサイゴン', '獺月': '蟻月', '蟬月': '蟻月',
}
function canonFoodcourtReports(reports: Array<Record<string, unknown>>): void {
  for (const r of reports || []) {
    const raw = Array.isArray((r as { tenants?: unknown }).tenants) ? (r as { tenants?: unknown[] }).tenants as unknown[] : []
    for (const t of raw) {
      if (!t || typeof t !== 'object') continue
      const o = t as Record<string, unknown>
      const code = o.code != null ? String(o.code).replace(/[^\d]/g, '') : ''
      if (code && FC_CODE_TO_NAME[code]) { o.name = FC_CODE_TO_NAME[code]; continue }
      const nm = String(o.name ?? '').trim()
      if (FC_NAME_ALIASES[nm]) o.name = FC_NAME_ALIASES[nm]
    }
  }
}

function fieldRow(label: string, value: string): Record<string, unknown> {
  return {
    type: 'box', layout: 'baseline', spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#8a96a3', flex: 3 },
      { type: 'text', text: value, size: 'sm', color: '#333333', flex: 7, wrap: true },
    ],
  }
}

// 比較カード（Flex）。コンパクトなサマリー＋上位3店。
export function buildFoodCourtCompareFlex(cmp: FoodCourtComparison): Record<string, unknown> {
  const top = cmp.rows.slice(0, 3).map((r, i) =>
    fieldRow(`${i + 1}位 ${r.name}`, r.salesRatio != null ? pct1(r.salesRatio) : '—'))
  const unitLine = cmp.baseUnit != null ? `${yen(cmp.baseUnit)}（${cmp.count}店中 ${cmp.unitRank}位）` : '—'
  return {
    type: 'flex',
    altText: `フードコート売上比較（基準 ${cmp.baseName}）`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: '🍴 フードコート内 売上比較', weight: 'bold', size: 'md', color: '#1a6fa8' },
          { type: 'text', text: `基準: ${cmp.baseName} ＝ 100（売上には登録していません／分析のみ）`, size: 'xs', color: '#8a96a3', wrap: true },
          { type: 'separator', margin: 'md' },
          fieldRow('基準店の売上', `${yen(cmp.baseSales)}（${cmp.count}店中 ${cmp.salesRank}位）`),
          fieldRow('基準店の客数', `${cmp.baseGuests || '—'}（${cmp.count}店中 ${cmp.guestRank}位）`),
          fieldRow('基準店の客単価', unitLine),
          fieldRow('フードコート内シェア', cmp.baseSharePct != null ? pct1(cmp.baseSharePct) : '—'),
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '売上トップ3（基準店=100）', size: 'xs', color: '#8a96a3', margin: 'sm' },
          ...top,
        ],
      },
    },
  }
}

// 短い記録通知（毎回の分析結果は出さず「記録した・サイトで質問してね」＋分析ページボタン）。
export function buildFoodCourtAckFlex(n: number, pageUrl?: string | null): Record<string, unknown> {
  const bubble: Record<string, unknown> = {
    type: 'bubble',
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        { type: 'text', text: '📊 フードコート集計を記録しました', weight: 'bold', size: 'md', color: '#1a6fa8' },
        { type: 'text', text: `${n}テナント分を保存（売上には登録していません）。`, size: 'sm', color: '#444444', wrap: true },
        { type: 'text', text: '下のボタンから分析ページを開き、データに質問できます。', size: 'xs', color: '#8a96a3', wrap: true },
      ],
    },
  }
  const url = String(pageUrl ?? '').trim()
  if (url) {
    bubble.footer = {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        { type: 'button', style: 'primary', color: '#1a6fa8', height: 'sm', action: { type: 'uri', label: 'フードコート分析を開く', uri: url } },
      ],
    }
  }
  return { type: 'flex', altText: 'フードコート集計を記録しました', contents: bubble }
}

async function groqChat(
  messages: Array<{ role: string; content: string }>,
  apiKey: string,
  model: string,
  maxTokens = 800,
): Promise<{ content: string | null; usage: FoodCourtAiUsage | null }> {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0.2, max_tokens: maxTokens, messages }),
    })
    if (!res.ok) { console.error('groqChat http error:', model, res.status); return { content: null, usage: null } }
    const json = await res.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }>; usage?: unknown } | null
    const c = String(json?.choices?.[0]?.message?.content ?? '').trim()
    return { content: c || null, usage: groqUsageFrom(json, model) }
  } catch (e) { console.error('groqChat failed:', e instanceof Error ? e.message : String(e)); return { content: null, usage: null } }
}

function fcDayLabel(r: Record<string, unknown>): string {
  const rd = String(r.report_date ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(rd)) return rd.slice(0, 10)
  const iso = String(r.created_at ?? '')
  const d = iso ? new Date(iso) : null
  if (d && !isNaN(d.getTime())) {
    const j = new Date(d.getTime() + 9 * 3600 * 1000)
    return `${j.getUTCFullYear()}-${String(j.getUTCMonth() + 1).padStart(2, '0')}-${String(j.getUTCDate()).padStart(2, '0')}`
  }
  return ''
}

function fcAvg(a: number[]): number | null { const x = a.filter((v) => v != null && isFinite(v)); return x.length ? x.reduce((s, v) => s + v, 0) / x.length : null }
function fcMedian(a: number[]): number | null { const x = a.filter((v) => v != null && isFinite(v)).slice().sort((p, q) => p - q); if (!x.length) return null; const m = Math.floor(x.length / 2); return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2 }
function fcDow(dateStr: string): number | null { const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m) return null; return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay() }
const FC_DOW = ['日', '月', '火', '水', '木', '金', '土']
const fcYen = (v: number) => '¥' + Math.round(v).toLocaleString('ja-JP')
const fcPct = (v: number) => (v >= 0 ? '+' : '') + (Math.round(v * 10) / 10).toFixed(1) + '%'

// 基準店の日次系列から、傾向・曜日・前日比・順位などを事前計算した分析メモを作る（モデルに渡して“列挙”を防ぐ）。
function buildBaseInsights(reports: Array<Record<string, unknown>>, baseName: string): string {
  const rows: Array<{ date: string; dow: number | null; sales: number; guests: number | null; kt: number | null; rank: number; share: number | null }> = []
  for (const r of reports || []) {
    const raw = Array.isArray((r as { tenants?: unknown }).tenants) ? (r as { tenants?: unknown[] }).tenants as unknown[] : []
    const list: Array<{ name: string; sales: number; guests: number | null }> = []
    for (const t of raw) {
      const o = (t && typeof t === 'object') ? t as Record<string, unknown> : {}
      const name = String(o.name ?? '').trim(); const sales = numOrNull(o.sales)
      if (name && sales != null && sales >= 0) list.push({ name, sales, guests: numOrNull(o.guests) })
    }
    if (list.length < 2) continue
    const base = list.find((t) => normalizeName(t.name) === normalizeName(baseName))
    if (!base) continue
    const total = list.reduce((s, t) => s + t.sales, 0)
    const date = (() => { const rd = String((r as { report_date?: unknown }).report_date ?? '').trim(); if (/^\d{4}-\d{2}-\d{2}/.test(rd)) return rd.slice(0, 10); return fcDayLabel(r) })()
    rows.push({ date, dow: fcDow(date), sales: base.sales, guests: base.guests, kt: (base.guests && base.guests > 0) ? base.sales / base.guests : null, rank: 1 + list.filter((t) => t.sales > base.sales).length, share: total > 0 ? base.sales / total * 100 : null })
  }
  rows.sort((a, b) => a.date.localeCompare(b.date))
  if (!rows.length) return ''
  const sales = rows.map((r) => r.sales)
  const guests = rows.map((r) => r.guests).filter((x): x is number => x != null)
  const kts = rows.map((r) => r.kt).filter((x): x is number => x != null)
  const ranks = rows.map((r) => r.rank)
  const maxR = rows.reduce((m, r) => r.sales > m.sales ? r : m, rows[0])
  const minR = rows.reduce((m, r) => r.sales < m.sales ? r : m, rows[0])
  const half = Math.floor(rows.length / 2)
  const firstAvg = half ? fcAvg(rows.slice(0, half).map((r) => r.sales)) : null
  const lateAvg = half ? fcAvg(rows.slice(rows.length - half).map((r) => r.sales)) : null
  const ktFirst = half ? fcAvg(rows.slice(0, half).map((r) => r.kt ?? NaN)) : null
  const ktLate = half ? fcAvg(rows.slice(rows.length - half).map((r) => r.kt ?? NaN)) : null
  const we = fcAvg(rows.filter((r) => r.dow === 0 || r.dow === 6).map((r) => r.sales))
  const wd = fcAvg(rows.filter((r) => r.dow != null && r.dow !== 0 && r.dow !== 6).map((r) => r.sales))
  let up: { d: number; to: typeof rows[0] } | null = null, dn: { d: number; to: typeof rows[0] } | null = null
  for (let i = 1; i < rows.length; i++) { const d = rows[i].sales - rows[i - 1].sales; if (!up || d > up.d) up = { d, to: rows[i] }; if (!dn || d < dn.d) dn = { d, to: rows[i] } }
  const dd = (r: { date: string; dow: number | null }) => `${r.date}(${r.dow != null ? FC_DOW[r.dow] : '?'})`
  const L: string[] = []
  L.push(`期間: ${rows[0].date}〜${rows[rows.length - 1].date}（${rows.length}日分）`)
  L.push(`売上: 合計${fcYen(sales.reduce((s, v) => s + v, 0))} / 日平均${fcYen(fcAvg(sales) ?? 0)} / 中央値${fcYen(fcMedian(sales) ?? 0)}`)
  L.push(`最高売上日: ${dd(maxR)} ${fcYen(maxR.sales)} / 最低売上日: ${dd(minR)} ${fcYen(minR.sales)}`)
  if (firstAvg && lateAvg) L.push(`傾向(前半→後半の日平均): ${fcYen(firstAvg)}→${fcYen(lateAvg)}（${fcPct((lateAvg / firstAvg - 1) * 100)}＝${lateAvg >= firstAvg ? '上昇' : '下降'}基調）`)
  if (we && wd) L.push(`曜日差: 土日平均${fcYen(we)} / 平日平均${fcYen(wd)}（土日は平日の${(we / wd).toFixed(2)}倍）`)
  if (up) L.push(`最大の増加: ${dd(up.to)} ${fcYen(up.to.sales)}（前日比 +${fcYen(up.d)}）`)
  if (dn) L.push(`最大の減少: ${dd(dn.to)} ${fcYen(dn.to.sales)}（前日比 ${fcYen(dn.d)}）`)
  if (ranks.length) L.push(`FC内売上順位: 平均${(fcAvg(ranks) ?? 0).toFixed(1)}位 / 最高${Math.min(...ranks)}位・最低${Math.max(...ranks)}位（全${(rows[0] && 11) || 11}店規模）`)
  if (ktFirst && ktLate) L.push(`客単価(前半→後半の平均): ${fcYen(ktFirst)}→${fcYen(ktLate)}`)
  if (kts.length) L.push(`客単価レンジ: 平均${fcYen(fcAvg(kts) ?? 0)} / ${fcYen(Math.min(...kts))}〜${fcYen(Math.max(...kts))}`)
  if (guests.length) L.push(`客数: 日平均${Math.round(fcAvg(guests) ?? 0)}人 / ${Math.min(...guests)}〜${Math.max(...guests)}人`)
  return L.join('\n')
}

// 基準店の日次（日付・客数・売上）を抽出する。イベント相関の計算に使う。
function fcBaseDaily(reports: Array<Record<string, unknown>>, baseName: string): Array<{ date: string; guests: number | null; sales: number }> {
  const out: Array<{ date: string; guests: number | null; sales: number }> = []
  for (const r of reports || []) {
    const raw = Array.isArray((r as { tenants?: unknown }).tenants) ? (r as { tenants?: unknown[] }).tenants as unknown[] : []
    let base: { sales: number; guests: number | null } | null = null
    for (const t of raw) {
      const o = (t && typeof t === 'object') ? t as Record<string, unknown> : {}
      const name = String(o.name ?? '').trim()
      if (name && normalizeName(name) === normalizeName(baseName)) {
        const sales = numOrNull(o.sales)
        if (sales != null) base = { sales, guests: numOrNull(o.guests) }
      }
    }
    if (!base) continue
    const rd = String((r as { report_date?: unknown }).report_date ?? '').trim()
    const date = /^\d{4}-\d{2}-\d{2}/.test(rd) ? rd.slice(0, 10) : fcDayLabel(r)
    out.push({ date, guests: base.guests, sales: base.sales })
  }
  out.sort((a, b) => a.date.localeCompare(b.date))
  return out
}

// 東京ドームのイベントと基準店客数の相関を事前計算（イベント日 vs 非イベント日、ジャンル別）。
function buildEventCorrelation(reports: Array<Record<string, unknown>>, baseName: string, events: VenueEvent[]): string {
  if (!Array.isArray(events) || !events.length) return ''
  const byDate = new Map<string, VenueEvent[]>()
  for (const e of events) {
    const d = String(e.event_date ?? '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue
    if (!byDate.has(d)) byDate.set(d, [])
    byDate.get(d)!.push(e)
  }
  const daily = fcBaseDaily(reports, baseName).filter((r) => r.guests != null)
  if (!daily.length) return ''
  const ev: number[] = []; const nonEv: number[] = []
  const evS: number[] = []; const nonEvS: number[] = []
  const byCat = new Map<string, number[]>()
  for (const r of daily) {
    const hits = byDate.get(r.date) || []
    if (hits.length) {
      ev.push(r.guests as number); evS.push(r.sales)
      for (const h of hits) { const c = h.category || 'その他'; if (!byCat.has(c)) byCat.set(c, []); byCat.get(c)!.push(r.guests as number) }
    } else { nonEv.push(r.guests as number); nonEvS.push(r.sales) }
  }
  const L: string[] = []
  const evAvg = fcAvg(ev); const nonAvg = fcAvg(nonEv)
  if (evAvg != null && nonAvg != null) {
    const ratio = nonAvg > 0 ? evAvg / nonAvg : null
    L.push(`イベント日(${ev.length}日)の平均客数 ${Math.round(evAvg)}人 / 非イベント日(${nonEv.length}日)の平均客数 ${Math.round(nonAvg)}人${ratio ? `（${ratio.toFixed(2)}倍）` : ''}`)
  } else if (evAvg != null) {
    L.push(`イベント日(${ev.length}日)の平均客数 ${Math.round(evAvg)}人（非イベント日のデータが不足）`)
  }
  const evSa = fcAvg(evS); const nonSa = fcAvg(nonEvS)
  if (evSa != null && nonSa != null) L.push(`イベント日の平均売上 ${fcYen(evSa)} / 非イベント日 ${fcYen(nonSa)}`)
  const cats = Array.from(byCat.entries()).filter(([, a]) => a.length).sort((a, b) => (fcAvg(b[1]) ?? 0) - (fcAvg(a[1]) ?? 0))
  for (const [c, a] of cats) L.push(`・${c}: ${a.length}日 / 平均客数 ${Math.round(fcAvg(a) ?? 0)}人`)
  // データのある日付ごとのイベント有無を提示（モデルが個別イベントを名指しで語れるように・売上も添える）
  const sample = daily.slice(-14).map((r) => { const hits = byDate.get(r.date) || []; const lab = hits.length ? hits.map((h) => `${h.category}:${h.title}`).join('｜') : 'イベントなし'; const dw = fcDow(r.date); return `${r.date}(${dw != null ? FC_DOW[dw] : '?'}) 客数${r.guests}人 売上${fcYen(r.sales)} ${lab}` })
  if (sample.length) L.push('—\n直近の日別イベント（この具体的な対応を使って“どのイベントがどう効いたか”を述べること）:\n' + sample.join('\n'))
  return L.join('\n')
}

// 今後の会場イベント予定をテキスト化（最大25件）。
function buildEventListText(events: VenueEvent[]): string {
  if (!Array.isArray(events) || !events.length) return ''
  const sorted = events.slice().filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(String(e.event_date ?? '').slice(0, 10)))
    .sort((a, b) => String(a.event_date).localeCompare(String(b.event_date))).slice(0, 25)
  return sorted.map((e) => { const d = e.event_date.slice(0, 10); const dw = fcDow(d); return `${d}(${dw != null ? FC_DOW[dw] : '?'}) [${e.category}] ${e.title}` }).join('\n')
}

export type VenueEvent = { event_date: string; title: string; category: string }
export type WeatherDay = { weather_date: string; weather_code: number | null; temp_max: number | null; temp_min: number | null; precipitation_mm: number | null; precip_prob: number | null; summary: string }

// 天気と基準店客数の相関を事前計算（雨の日 vs 雨でない日、天気区分別、気温）。
function buildWeatherCorrelation(reports: Array<Record<string, unknown>>, baseName: string, weather: WeatherDay[]): string {
  if (!Array.isArray(weather) || !weather.length) return ''
  const byDate = new Map<string, WeatherDay>()
  for (const w of weather) { const d = String(w.weather_date ?? '').slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(d)) byDate.set(d, w) }
  const daily = fcBaseDaily(reports, baseName).filter((r) => r.guests != null)
  if (!daily.length) return ''
  const rainG: number[] = [], dryG: number[] = [], rainS: number[] = [], dryS: number[] = []
  const hotG: number[] = [], coolG: number[] = []
  const byCat = new Map<string, number[]>()
  for (const r of daily) {
    const w = byDate.get(r.date); if (!w) continue
    const g = r.guests as number
    const rainy = (w.precipitation_mm ?? 0) >= 1
    if (rainy) { rainG.push(g); rainS.push(r.sales) } else { dryG.push(g); dryS.push(r.sales) }
    const cat = w.summary || '—'; if (!byCat.has(cat)) byCat.set(cat, []); byCat.get(cat)!.push(g)
    if (w.temp_max != null) { if (w.temp_max >= 30) hotG.push(g); else coolG.push(g) }
  }
  const L: string[] = []
  const rA = fcAvg(rainG), dA = fcAvg(dryG)
  if (rA != null && dA != null) {
    const ratio = dA > 0 ? rA / dA : null
    L.push(`雨の日(${rainG.length}日)の平均客数 ${Math.round(rA)}人 / 雨でない日(${dryG.length}日)の平均客数 ${Math.round(dA)}人${ratio ? `（${ratio.toFixed(2)}倍）` : ''}`)
    const rsa = fcAvg(rainS), dsa = fcAvg(dryS)
    if (rsa != null && dsa != null) L.push(`雨の日の平均売上 ${fcYen(rsa)} / 雨でない日 ${fcYen(dsa)}`)
  } else if (rA != null) {
    L.push(`雨の日(${rainG.length}日)の平均客数 ${Math.round(rA)}人（雨でない日のデータが不足）`)
  } else if (dA != null) {
    L.push(`雨でない日(${dryG.length}日)の平均客数 ${Math.round(dA)}人（雨の日のデータがまだ無い）`)
  }
  const hA = fcAvg(hotG), cA = fcAvg(coolG)
  if (hA != null && cA != null) L.push(`真夏日(最高30℃以上 ${hotG.length}日)の平均客数 ${Math.round(hA)}人 / それ未満(${coolG.length}日) ${Math.round(cA)}人`)
  const cats = Array.from(byCat.entries()).filter(([, a]) => a.length).sort((a, b) => (fcAvg(b[1]) ?? 0) - (fcAvg(a[1]) ?? 0))
  for (const [c, a] of cats) L.push(`・${c}: ${a.length}日 / 平均客数 ${Math.round(fcAvg(a) ?? 0)}人`)
  return L.join('\n')
}

// FOOD STADIUM TOKYO（東京ドームシティのフードホール）の競合店プロファイル。
// 詳細は docs/フードコート競合店プロファイル.md（こちらが正本／改装時は両方更新）。
// 客単価は業態差が大きいため、AIが「単価順位」を業態文脈で正しく解釈できるよう注入する。
const FOODCOURT_STORE_PROFILES: Array<{ name: string; genre: string; price: string; drink: string; note: string }> = [
  { name: 'MARUGO S', genre: 'ワインバル＋スパイスカレー', price: '昼¥1,000-1,999/夜¥3,000-3,999(FC最高単価ゾーン)', drink: 'やや飲み(ワイン)寄り', note: '施設で唯一の本格ワイン×スパイス。高単価・大人路線。ワイン需要をほぼ独占＝強み' },
  { name: 'クラフトビアマーケット', genre: 'クラフトビール×バーガー', price: '¥2,000-2,999', drink: '飲み(ビール)中心', note: 'ビール20〜30種＋スマッシュバーガー' },
  { name: 'ニュー大金星', genre: '大衆居酒屋(鉄板/揚物)', price: '¥1,000-1,999', drink: '両立(食事寄り)', note: '鉄板焼きそば。汎用性高' },
  { name: '新御茶ノ水 萬龍', genre: '中華(ネオ町中華)', price: '昼¥1,000-1,999/夜〜¥2,999', drink: '食事中心', note: '肉玉炒飯。行列町中華2号店' },
  { name: 'ベトナム屋台バインセオサイゴン', genre: 'ベトナム料理(屋台)', price: '約¥1,000-1,500', drink: '食事中心', note: 'バインセオ/フーティウ。本場志向' },
  { name: 'A destra Salvatore', genre: 'イタリアン(ピザ/パスタ)', price: '昼¥1,000-1,999/夜¥3,000-3,999', drink: '食事中心＋ワイン', note: 'サルヴァトーレ系。MARUGO Sと並ぶ夜の最高単価' },
  { name: '水道橋 すしわさび', genre: '寿司酒場', price: '昼¥1,000-1,999/夜は3-5千の可能性', drink: '飲み寄り(寿司飲み)', note: 'わさびバラちらし。地酒充実' },
  { name: '蟻月', genre: '博多もつ鍋', price: '¥1,000-1,999', drink: '食事中心(当店)', note: '白/赤もつ鍋＋カップもつ鍋。フード寄り最適化' },
  { name: 'ラーメン＆酒バル 麺屋一燈', genre: 'ラーメン＆酒バル', price: '¥1,000-1,999', drink: '食事(ラーメン)主軸＋飲み', note: '濃厚魚介つけ麺。施設内で高評価' },
  { name: 'チャルモゴッソヨ', genre: '韓国料理/韓国酒場', price: '昼約¥1,300-1,800/夜約¥2,000-3,000', drink: '両立(酒場＋定食)', note: '映え×健康志向。若年・女性層に強い' },
  { name: '台湾点心とビール 恒久飯店', genre: '台湾点心×クラフトビール', price: '推定¥1,500-2,500', drink: '飲み(ビール)寄り', note: 'ブルワリー運営。点心×ビール' },
]

// 競合プロファイルを、実データに登場する店だけに絞ってテキスト化（基準店に★）。
function buildCompetitorContext(reports: Array<Record<string, unknown>>, baseName: string): string {
  const present = new Set<string>()
  for (const r of (reports || [])) {
    const raw = Array.isArray((r as { tenants?: unknown }).tenants) ? (r as { tenants?: unknown[] }).tenants as unknown[] : []
    for (const t of raw) { const nm = String(((t && typeof t === 'object') ? (t as Record<string, unknown>).name : '') ?? '').trim(); if (nm) present.add(normalizeName(nm)) }
  }
  const lines: string[] = ['施設: FOOD STADIUM TOKYO（東京ドーム内・共有席のフードホール／全店アルコール提供／イベント前後の来場客が回遊）。']
  lines.push('注意: 客単価は業態差が大きい（ワイン/イタリアン＝高単価、ラーメン/ベトナム/もつ鍋＝低単価）。単価の順位は業態由来なので「単価順位の上下」より「業態として妥当か」「客数(集客)で勝てているか」で評価すること。')
  for (const p of FOODCOURT_STORE_PROFILES) {
    if (present.size && !present.has(normalizeName(p.name))) continue
    const mark = normalizeName(p.name) === normalizeName(baseName) ? '★基準 ' : ''
    lines.push(`・${mark}${p.name}｜${p.genre}｜単価${p.price}｜${p.drink}｜${p.note}`)
  }
  return lines.join('\n')
}

// 蓄積されたフードコート日次データを根拠に、ユーザーの質問へ回答する（Groqテキスト／安価）。
// events（東京ドームのイベント日程）・weather（日次天気）を渡すと、客数増減との相関も踏まえて回答する。
// 競合店プロファイル（業態・価格帯・飲み/食事傾向）も注入し、業態文脈を踏まえた分析にする。
export async function answerFoodCourtQuestion(
  reports: Array<Record<string, unknown>>,
  baseName: string,
  question: string,
  groqApiKey: string,
  events: VenueEvent[] = [],
  weather: WeatherDay[] = [],
  supabase?: SupabaseClient | null,
  storeKey?: string,
): Promise<string | null> {
  if (!groqApiKey) return null
  const q = String(question ?? '').trim().slice(0, 500)
  if (!q) return null
  canonFoodcourtReports(reports) // OCR誤読の店名を安定codeで正規化し、11店として一貫分析する
  const blocks: string[] = []
  for (const r of (reports || []).slice(0, 45)) {
    const rawTenants = Array.isArray((r as { tenants?: unknown }).tenants) ? (r as { tenants?: unknown[] }).tenants as unknown[] : []
    const rows: string[] = []
    for (const t of rawTenants) {
      const o = (t && typeof t === 'object') ? t as Record<string, unknown> : {}
      const name = String(o.name ?? '').trim()
      const sales = numOrNull(o.sales)
      if (!name || sales == null) continue
      const guests = numOrNull(o.guests)
      const kt = (guests && guests > 0) ? Math.round(sales / guests) : null
      const mark = normalizeName(name) === normalizeName(baseName) ? '★基準' : ''
      rows.push(`${name}${mark}\t売上${sales}\t客数${guests ?? '-'}\t客単価${kt ?? '-'}`)
    }
    if (rows.length) blocks.push(`■${fcDayLabel(r)}\n${rows.join('\n')}`)
  }
  if (!blocks.length) return 'まだ分析できるデータがありません。フードコートのテナント一覧画像を送ると蓄積されます。'
  const data = blocks.reverse().join('\n\n')
  const insights = buildBaseInsights(reports, baseName)
  const eventCorr = buildEventCorrelation(reports, baseName, events)
  const eventList = buildEventListText(events)
  const weatherCorr = buildWeatherCorrelation(reports, baseName, weather)
  const competitors = buildCompetitorContext(reports, baseName)
  const system = [
    `あなたは「${baseName}」（東京ドーム内フードホール「FOOD STADIUM TOKYO」の1店舗）専属の、飲食業界に精通したシニア市場アナリスト兼経営コンサルタントです。`,
    `目的は「表を見れば分かる事実の再掲」ではなく、数字の“奥”を読み解いた洞察（市場調査レベルの考察）を提供することです。`,
    `【厳守・禁止】「売上は¥◯、客単価は¥◯、◯位です」のように表の値をそのまま言い換えるだけ／最大・最小をただ列挙するだけの回答は禁止。数字は根拠として最小限だけ引用し、必ず「だから何を意味するか（原因・メカニズム・顧客行動・示唆）」をセットで述べること。`,
    `【必ず市場調査として読み解く・以下を踏まえる】`,
    `(1) 競合プロファイル（各店の業態・提供する料理/飲み物・飲み中心か食事中心か）を必ず使い、“なぜその数字になるのか”を業態のメカニズムで説明する。例: 客単価の高低は業態（ワイン×スパイス＝高単価／ラーメン・ベトナム・もつ鍋＝低単価）の必然か想定外か。客数が伸びにくいのは「高単価で意思決定コストが高い業態だから」か。`,
    `(2) 顧客の利用シーン・来店動機を推定する（野球/ライブ観戦の前後の一杯、待ち時間の軽食、がっつり飯、デート・接待、インバウンド、ファミリー等）。${baseName}はどの動機を取れていて、どれを取りこぼしているか。`,
    `(3) 真の競合（代替関係）を特定する。席は共有なので“客の財布と滞在時間”の奪い合い。同じ来店動機・時間帯・価格帯で客を奪い合う相手はどの店か。同ジャンル競合の有無（ワインは自店がほぼ独占）も強み/弱みとして語る。`,
    `(4) 需要ドライバーの中でも【東京ドームのイベント】を最重要視し、具体的に深掘りする。提供データの「会場イベント相関」「直近の日別イベント（日付・客数・売上・イベント名つき）」を必ず使い、客数・売上に動きがある日は次を必ず述べる: (a) その日に**どんなイベントが・いつ（昼興行か夜公演か）あったかをイベント名・種別・規模・客層まで特定**する（例: NiziUライブ＝若年女性中心で物販・グッズ後の軽い飲食、巨人戦などプロ野球＝幅広い年齢の野球ファンで試合前後に長め滞在、大学野球＝昼開催で飲酒需要が薄い、コンサート＝開演前後に集中、等）。(b) そのイベントが${baseName}の客数・売上に**どれだけ・なぜ**効いた/効かなかったかを実数を引用してメカニズムで説明する（観客の客層・財布・滞在時間・開演時間帯と、ワイン×スパイスという高単価・大人向け業態の相性）。(c) 取り込めたイベント／取りこぼしたイベントを切り分け、次に同種のイベントが来たときの打ち手につなげる。「イベント日は客数が多い」で終わらせない。天気・曜日は補助要因として絡める。`,
    `(5) 自店の構造的な強み・弱みと打開仮説。打ち手は「誰の・どの来店動機を・どう取るか」まで具体化し、検証方法（次に何の数字を見れば効果が分かるか）も添える。`,
    `【出力スタイル】結論を先に → 根拠（数字は最小限＋競合/業態/利用シーンの文脈）→ 示唆・打ち手（具体的で検証可能な仮説）。短い見出し＋箇条書き。断定できないことは「仮説」と明示し、データに無いことは「データにありません」と述べ捏造しない。新規オープンで前年比は無いため、自店の履歴と業態特性を基準に語る。客単価の順位は業態由来なので単価の高低そのものを優劣にしない（集客＝客数で評価する）。`,
  ].join('\n')
  const userMsg = `# 競合プロファイル（FOOD STADIUM TOKYO）\n${competitors}\n\n# 事前計算サマリー（基準店）\n${insights || '(履歴不足)'}\n\n# 会場イベント相関（東京ドーム）\n${eventCorr || '(イベントデータなし)'}\n\n# 今後の会場イベント予定\n${eventList || '(予定データなし)'}\n\n# 天気相関（東京ドーム周辺）\n${weatherCorr || '(天気データなし)'}\n\n# 日次生データ（全テナント）\n${data}\n\n# 質問\n${q}`
  const primary = String(Deno.env.get('GROQ_CHAT_MODEL') || '').trim() || 'llama-3.3-70b-versatile'
  const r1 = await groqChat([{ role: 'system', content: system }, { role: 'user', content: userMsg }], groqApiKey, primary, 1800)
  let ans = r1.content
  let usage = r1.usage
  if (!ans) {
    const r2 = await groqChat([{ role: 'system', content: system }, { role: 'user', content: userMsg }], groqApiKey, 'meta-llama/llama-4-scout-17b-16e-instruct', 1800)
    ans = r2.content
    if (r2.usage) usage = r2.usage
  }
  // Q&Aの実測トークンをAI使用料に合算（best-effort・store_partition_keyで集計に乗る）。
  await recordFoodCourtAiUsage(supabase, String(storeKey ?? ''), null, usage)
  return ans
}

export async function saveFoodCourtReport(
  supabase: SupabaseClient,
  params: { storeKey: string; roomId: string; lineMessageId: string; baseName: string; tenants: FoodCourtTenant[] },
): Promise<void> {
  try {
    await supabase.from('foodcourt_tenant_reports').upsert({
      store_partition_key: params.storeKey,
      room_id: params.roomId,
      line_message_id: params.lineMessageId,
      base_tenant_name: params.baseName,
      tenants: params.tenants,
    }, { onConflict: 'line_message_id' })
  } catch (e) {
    console.error('saveFoodCourtReport failed:', e instanceof Error ? e.message : String(e))
  }
}

// オーケストレーション: 対象店舗＋マーカー一致のとき Gemini で抽出 → 比較が成立すれば
//   保存＋カードを返し handled=true（売上登録しない）。成立しなければ handled=false（通常処理へ）。
export async function maybeHandleFoodCourtReport(
  supabase: SupabaseClient,
  params: {
    storeKey: string
    roomId: string
    lineMessageId: string
    bytes: Uint8Array
    contentType: string | null
    detectText: string
    geminiApiKey: string
    geminiModel: string
    groqApiKey?: string
    /** 自店レシートとして確信できない画像のとき true＝マーカー不一致でも抽出を試す（検知の取りこぼし防止）。 */
    forceAttempt?: boolean
  },
): Promise<{ handled: boolean; reply?: Record<string, unknown> }> {
  const cfg = FOODCOURT_STORE_KEYS[String(params.storeKey ?? '')]
  if (!cfg) return { handled: false }
  if (!looksLikeFoodCourtReport(params.detectText) && !params.forceAttempt) return { handled: false }

  // Groqで十分とみなす最小テナント数（想定数-1。安価なGroqを優先しつつ取りこぼし時だけGeminiへ）。
  const minOk = cfg.expectedTenants ? Math.max(5, cfg.expectedTenants - 1) : 5
  const valid = (ts: FoodCourtTenant[] | null) =>
    (ts && ts.length >= 3 && computeFoodCourtComparison(ts, cfg.baseTenantName)) ? ts : null

  // 画像抽出で消費したトークンを記録（成立有無に関わらず・AI使用料に反映）。
  const aiUsages: FoodCourtAiUsage[] = []
  const onUsage = (u: FoodCourtAiUsage) => { aiUsages.push(u) }
  // 1) まず安価な Groq(llama-4-scout) で抽出（印字されたクリーンな表は読める想定）。
  let tenants = valid(await extractFoodCourtTenantsGroq(params.bytes, params.contentType, params.groqApiKey ?? '', 25000, onUsage))
  // 2) Groqが表として成立しない or テナント数が想定より少ない（読み落とし疑い）→ 高精度な Gemini にフォールバック。
  if ((!tenants || tenants.length < minOk) && params.geminiApiKey) {
    const g = valid(await extractFoodCourtTenants(params.bytes, params.contentType, params.geminiApiKey, params.geminiModel, 30000, onUsage))
    if (g) tenants = g
  }
  for (const u of aiUsages) await recordFoodCourtAiUsage(supabase, params.storeKey, params.lineMessageId, u)
  if (!tenants) return { handled: false } // どちらも成立しない → 通常のレシート処理へ

  const cmp = computeFoodCourtComparison(tenants, cfg.baseTenantName)
  if (!cmp) return { handled: false }

  await saveFoodCourtReport(supabase, {
    storeKey: params.storeKey, roomId: params.roomId, lineMessageId: params.lineMessageId,
    baseName: cfg.baseTenantName, tenants,
  })
  // 毎回の分析結果は出さず、短い記録通知＋店舗限定の分析ページリンクを返す（分析はサイトで質問）。
  const pageUrl = await buildFoodCourtDashboardLink(supabase, params.storeKey)
  return { handled: true, reply: buildFoodCourtAckFlex(tenants.length, pageUrl) }
}
