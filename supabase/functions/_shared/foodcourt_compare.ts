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

function fcAddDays(ymd: string, n: number): string {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return ''
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n))
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}
// テナント一覧は「翌朝に出る“前日”の売上比較表」。report_date はレポート発行日なので、
// 実際の売上が発生した日は前日(-1)。AIに渡す日付・相関はすべてこの“売上日”に揃える。
export function fcSalesDate(r: Record<string, unknown>): string {
  const rd = String((r as { report_date?: unknown }).report_date ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(rd)) return fcAddDays(rd.slice(0, 10), -1)
  const iso = String((r as { created_at?: unknown }).created_at ?? '')
  const d = iso ? new Date(iso) : null
  if (d && !isNaN(d.getTime())) {
    const j = new Date(d.getTime() + 9 * 3600 * 1000)
    return fcAddDays(`${j.getUTCFullYear()}-${String(j.getUTCMonth() + 1).padStart(2, '0')}-${String(j.getUTCDate()).padStart(2, '0')}`, -1)
  }
  return ''
}
// 日次表示・相関のキーは「売上日」（report_date の前日）に統一する。
function fcDayLabel(r: Record<string, unknown>): string {
  return fcSalesDate(r)
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
    const date = fcSalesDate(r) // 売上日（report_date の前日）に統一
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
    const date = fcSalesDate(r) // 売上日（report_date の前日）に統一
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
  if (byCat.has('スポーツ中継')) L.push('注: スポーツ中継(PV観戦)は全体の集客が大きい日。当店への売上寄与は固定視せず、上の「客数」と「客単価/売上」の実績数値で都度判断すること（断定しない・蓄積で更新）。現場の仮説として『サッカー放映は客がバーガー/ビールに流れやすく、野球の方が当店売上は伸びやすい』があるが、あくまで仮説で、競技・放映時間帯ごとの実際の数値で検証する。')
  // 会場別（東京ドーム本体／カナデビアホール／後楽園ホール等）の平均客数。会場で客層が異なるため取り込み方を読む。
  const byVenue = new Map<string, number[]>()
  for (const r of daily) {
    const hits = byDate.get(r.date) || []
    const vs = new Set(hits.map((h) => String(h.venue ?? 'tokyo-dome')))
    for (const v of vs) { if (!byVenue.has(v)) byVenue.set(v, []); byVenue.get(v)!.push(r.guests as number) }
  }
  const venName = (v: string) => fcVenueLabel(v) || (v === 'tokyo-dome' ? '東京ドーム' : v)
  const venRows = Array.from(byVenue.entries()).filter(([, a]) => a.length).sort((a, b) => (fcAvg(b[1]) ?? 0) - (fcAvg(a[1]) ?? 0))
  if (venRows.length >= 2) { L.push('会場別の平均客数（会場で客層が違う＝取り込み方を変える）:'); for (const [v, a] of venRows) L.push(`・${venName(v)}: ${a.length}日 / 平均客数 ${Math.round(fcAvg(a) ?? 0)}人`) }
  // データのある日付ごとのイベント有無を提示（モデルが個別イベントを名指しで語れるように・売上も添える）
  const sample = daily.slice(-14).map((r) => { const hits = byDate.get(r.date) || []; const lab = hits.length ? hits.map((h) => { const vl = fcVenueLabel(h.venue); return `${h.category}${vl ? `@${vl}` : ''}:${h.title}` }).join('｜') : 'イベントなし'; const dw = fcDow(r.date); return `${r.date}(${dw != null ? FC_DOW[dw] : '?'}) 客数${r.guests}人 売上${fcYen(r.sales)} ${lab}` })
  if (sample.length) L.push('—\n直近の日別イベント（この具体的な対応を使って“どのイベントがどう効いたか”を述べること）:\n' + sample.join('\n'))
  return L.join('\n')
}

// 今後の会場イベント予定をテキスト化（最大25件）。
function buildEventListText(events: VenueEvent[]): string {
  if (!Array.isArray(events) || !events.length) return ''
  const sorted = events.slice().filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(String(e.event_date ?? '').slice(0, 10)))
    .sort((a, b) => String(a.event_date).localeCompare(String(b.event_date))).slice(0, 25)
  const lines = sorted.map((e) => { const d = e.event_date.slice(0, 10); const dw = fcDow(d); const vl = fcVenueLabel(e.venue); const jp = e.is_japan ? '🇯🇵日本戦(集客大・深夜営業あり) ' : ''; const nt = e.note ? ` ※${e.note}` : ''; return `${d}(${dw != null ? FC_DOW[dw] : '?'}) [${e.category}${vl ? `/${vl}` : ''}] ${jp}${e.title}${nt}` })
  // PV(スポーツ中継)の運用知見をAIが必ず踏まえるよう注記。
  if (sorted.some((e) => e.category === 'スポーツ中継')) {
    lines.push('※PV観戦(スポーツ中継)の見方: フードコート全体は集客増が見込める日。当店の売上寄与は断定せず、実績の客数/客単価/売上で判断する（蓄積で随時更新・固定の結論にしない）。現場の仮説として『サッカー放映は客がバーガー/ビールに流れやすく、野球の方が当店売上は伸びやすい』があるが要検証。日本戦は深夜営業の可能性に備える。')
  }
  return lines.join('\n')
}

export type VenueEvent = { event_date: string; title: string; category: string; venue?: string; is_japan?: boolean; note?: string }
export type ForecastRow = { target_date: string; metric: string; predicted: number; predicted_low?: number | null; predicted_high?: number | null; actual?: number | null; model_version?: string }

// 学習型モデルの予測（forecast_predictions）を、精度（過去の予測vs実績MAPE）＋今後の予測としてテキスト化。
function buildForecastContext(forecast: ForecastRow[]): string {
  if (!Array.isArray(forecast) || !forecast.length) return ''
  const byDate = new Map<string, { guests?: ForecastRow; sales?: ForecastRow }>()
  for (const r of forecast) {
    const d = String(r.target_date ?? '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue
    const o = byDate.get(d) ?? {}
    if (r.metric === 'guests') o.guests = r; else if (r.metric === 'sales') o.sales = r
    byDate.set(d, o)
  }
  const days = Array.from(byDate.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  const ape = (m: 'guests' | 'sales') => {
    const xs = days.map(([, o]) => o[m]).filter((r): r is ForecastRow => !!r && r.actual != null && (r.actual as number) > 0).map((r) => Math.abs(r.predicted - (r.actual as number)) / (r.actual as number))
    return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null
  }
  const mg = ape('guests'); const ms = ape('sales')
  const nEval = days.filter(([, o]) => o.guests && o.guests.actual != null).length
  const L: string[] = []
  L.push(`学習型モデル(${forecast[0].model_version ?? 'v1'})の自己採点: 直近${nEval}日の誤差 客数±${mg != null ? Math.round(mg * 100) : '—'}% / 売上±${ms != null ? Math.round(ms * 100) : '—'}%（データ蓄積で改善）。`)
  const today = jstTodayForFc()
  const fut = days.filter(([d]) => d >= today).slice(0, 10)
  for (const [d, o] of fut) {
    const dw = fcDow(d)
    const g = o.guests ? `客数${Math.round(o.guests.predicted)}人` : ''
    const s = o.sales ? `売上${fcYen(o.sales.predicted)}` : ''
    L.push(`${d}(${dw != null ? FC_DOW[dw] : '?'}) 予測 ${[g, s].filter(Boolean).join(' / ')}`)
  }
  return L.join('\n')
}
function jstTodayForFc(): string { const j = new Date(Date.now() + 9 * 3600 * 1000); return `${j.getUTCFullYear()}-${String(j.getUTCMonth() + 1).padStart(2, '0')}-${String(j.getUTCDate()).padStart(2, '0')}` }
// 会場ラベル（東京ドーム本体は無印で簡潔に、各ホールは会場名を明示してAIが客層差を読めるように）。
function fcVenueLabel(venue?: string): string {
  const v = String(venue ?? "").trim().toLowerCase()
  if (v === "kanadevia") return "カナデビアホール"
  if (v === "korakuen") return "後楽園ホール"
  if (v === "prism") return "プリズムホール"
  if (v === "laqua") return "ラクーア"
  if (v === "public-viewing") return "PV観戦(世界スポーツ放映)"
  return "" // tokyo-dome / 不明は無印
}
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

// --- 設計書フレームワーク用の統計ヘルパー（docs/フードコート売上分析_設計書.md）---
function fcStdev(a: number[]): number | null {
  const x = a.filter((v) => v != null && isFinite(v))
  if (x.length < 2) return null
  const m = x.reduce((s, v) => s + v, 0) / x.length
  return Math.sqrt(x.reduce((s, v) => s + (v - m) * (v - m), 0) / x.length)
}
function fcPearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length)
  const px: number[] = [], py: number[] = []
  for (let i = 0; i < n; i++) { if (xs[i] != null && ys[i] != null && isFinite(xs[i]) && isFinite(ys[i])) { px.push(xs[i]); py.push(ys[i]) } }
  const m = px.length
  if (m < 4) return null
  const mx = px.reduce((s, v) => s + v, 0) / m, my = py.reduce((s, v) => s + v, 0) / m
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < m; i++) { const dx = px[i] - mx, dy = py[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy }
  return (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : null
}

// 売上=客数×客単価 の要因分解（前半→後半の日平均で、増減を客数要因/単価要因/交互に切り分ける）。設計書 §2。
function buildContributionDecomposition(reports: Array<Record<string, unknown>>, baseName: string): string {
  const daily = fcBaseDaily(reports, baseName).filter((r) => r.guests != null && (r.guests as number) > 0)
  if (daily.length < 6) return ''
  const half = Math.floor(daily.length / 2)
  const first = daily.slice(0, half)
  const late = daily.slice(daily.length - half)
  const Sf = fcAvg(first.map((r) => r.sales)) ?? 0
  const Sl = fcAvg(late.map((r) => r.sales)) ?? 0
  const Gf = fcAvg(first.map((r) => r.guests as number)) ?? 0
  const Gl = fcAvg(late.map((r) => r.guests as number)) ?? 0
  if (Gf <= 0 || Gl <= 0 || Sf <= 0) return ''
  const Kf = Sf / Gf, Kl = Sl / Gl
  const dS = Sl - Sf
  const cG = (Gl - Gf) * Kf       // 客数要因
  const cK = (Kl - Kf) * Gf       // 客単価要因
  const cX = (Gl - Gf) * (Kl - Kf) // 交互
  const pct = (v: number) => dS !== 0 ? `${Math.round(v / Math.abs(dS) * 100)}%` : '—'
  const driver = Math.abs(cG) >= Math.abs(cK) ? '客数要因' : '客単価要因'
  return [
    `前半${first.length}日→後半${late.length}日の日平均: 売上 ${fcYen(Sf)}→${fcYen(Sl)}（${fcPct((Sl / Sf - 1) * 100)}）/ 客数 ${Math.round(Gf)}→${Math.round(Gl)}人 / 客単価 ${fcYen(Kf)}→${fcYen(Kl)}`,
    `増減${fcYen(dS)}の内訳 ≒ 客数要因${fcYen(cG)}(${pct(cG)}) ＋ 客単価要因${fcYen(cK)}(${pct(cK)}) ＋ 交互${fcYen(cX)}(${pct(cX)}) → 主因は【${driver}】`,
  ].join('\n')
}

// 店舗間の日次売上ピアソン相関（基準店 vs 各店）。負=カニバリ(食い合い)候補、正=連動/アンカー候補。設計書 §6・§8。
function buildStoreCorrelation(reports: Array<Record<string, unknown>>, baseName: string): string {
  const byDate = new Map<string, Map<string, number>>()
  const nameDisplay = new Map<string, string>()
  for (const r of (reports || [])) {
    const date = fcSalesDate(r)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const raw = Array.isArray((r as { tenants?: unknown }).tenants) ? (r as { tenants?: unknown[] }).tenants as unknown[] : []
    let m = byDate.get(date); if (!m) { m = new Map(); byDate.set(date, m) }
    for (const t of raw) {
      const o = (t && typeof t === 'object') ? t as Record<string, unknown> : {}
      const nm = String(o.name ?? '').trim(); const s = numOrNull(o.sales)
      if (!nm || s == null) continue
      const key = normalizeName(nm)
      m.set(key, s); if (!nameDisplay.has(key)) nameDisplay.set(key, nm)
    }
  }
  const dates = Array.from(byDate.keys()).sort()
  if (dates.length < 5) return ''
  const baseKey = normalizeName(baseName)
  const others = new Set<string>()
  for (const m of byDate.values()) for (const k of m.keys()) if (k !== baseKey) others.add(k)
  const results: Array<{ name: string; r: number; n: number }> = []
  for (const ok of others) {
    const bx: number[] = [], ox: number[] = []
    for (const d of dates) { const m = byDate.get(d)!; const b = m.get(baseKey); const o = m.get(ok); if (b != null && o != null) { bx.push(b); ox.push(o) } }
    const r = fcPearson(bx, ox)
    if (r != null) results.push({ name: nameDisplay.get(ok) || ok, r, n: bx.length })
  }
  if (!results.length) return ''
  results.sort((a, b) => a.r - b.r)
  const neg = results.filter((x) => x.r <= -0.3).slice(0, 3)
  const pos = results.filter((x) => x.r >= 0.5).sort((a, b) => b.r - a.r).slice(0, 3)
  const L: string[] = ['※相関は因果ではない（曜日・イベント等の共通要因で連動しうる）。']
  if (neg.length) L.push('カニバリ候補(負相関): ' + neg.map((x) => `${x.name} r=${x.r.toFixed(2)}(${x.n}日)`).join(' / '))
  else L.push('明確なカニバリ(強い負相関)は未検出。')
  if (pos.length) L.push('連動候補(正相関・アンカー/共通需要): ' + pos.map((x) => `${x.name} r=${x.r.toFixed(2)}(${x.n}日)`).join(' / '))
  return L.join('\n')
}

// 異常値（基準店の日次売上のZスコア |Z|≧2）。記録的な日/落ち込み日を平常から切り分ける。設計書 §6。
function buildAnomalyDays(reports: Array<Record<string, unknown>>, baseName: string, events: VenueEvent[], weather: WeatherDay[]): string {
  const daily = fcBaseDaily(reports, baseName)
  if (daily.length < 7) return ''
  const sales = daily.map((r) => r.sales)
  const mean = fcAvg(sales) ?? 0
  const sd = fcStdev(sales)
  if (!sd || sd <= 0) return ''
  const evByDate = new Map<string, VenueEvent[]>()
  for (const e of (events || [])) { const d = String(e.event_date ?? '').slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(d)) { if (!evByDate.has(d)) evByDate.set(d, []); evByDate.get(d)!.push(e) } }
  const wByDate = new Map<string, WeatherDay>()
  for (const w of (weather || [])) { const d = String(w.weather_date ?? '').slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(d)) wByDate.set(d, w) }
  const out: string[] = []
  for (const r of daily) {
    const z = (r.sales - mean) / sd
    if (Math.abs(z) < 2) continue
    const dw = fcDow(r.date); const ev = evByDate.get(r.date) || []; const w = wByDate.get(r.date)
    const ctx: string[] = [ev.length ? ev.map((e) => `${e.category}:${e.title}`).join('｜') : 'イベントなし']
    if (w && (w.precipitation_mm ?? 0) >= 1) ctx.push('雨')
    if (w && w.temp_max != null) ctx.push(`最高${w.temp_max}℃`)
    out.push(`${r.date}(${dw != null ? FC_DOW[dw] : '?'}) 売上${fcYen(r.sales)} Z=${z.toFixed(1)}（${z > 0 ? '突出' : '落込'}）｜${ctx.join('・')}`)
  }
  if (!out.length) return ''
  return `平均${fcYen(mean)}・SD${fcYen(sd)}。|Z|≧2の日（平常分析から切り分けて要因を見る）:\n` + out.slice(0, 8).join('\n')
}

// 「分析サマリー（自動）」1日分の日次サマリー用に、対象レポート(=1日)のFC内順位・シェア・自店史比較・
// イベント/天気・直近推移を事前計算する。AIには数字を作らせず、ここで計算した事実だけを渡して意味を語らせる。
function buildTargetDayFacts(
  reports: Array<Record<string, unknown>>,
  baseName: string,
  targetReport: Record<string, unknown>,
  events: VenueEvent[],
  weather: WeatherDay[],
): string {
  const date = fcSalesDate(targetReport)
  const raw = Array.isArray((targetReport as { tenants?: unknown }).tenants) ? (targetReport as { tenants?: unknown[] }).tenants as unknown[] : []
  type Row = { name: string; sales: number; guests: number | null; kt: number | null }
  const list: Row[] = []
  for (const t of raw) {
    const o = (t && typeof t === 'object') ? t as Record<string, unknown> : {}
    const name = String(o.name ?? '').trim(); const sales = numOrNull(o.sales)
    if (!name || sales == null) continue
    const guests = numOrNull(o.guests)
    list.push({ name, sales, guests, kt: (guests && guests > 0) ? sales / guests : null })
  }
  const base = list.find((t) => normalizeName(t.name) === normalizeName(baseName))
  if (!base || !list.length) return ''
  const byS = list.slice().sort((a, b) => b.sales - a.sales)
  const salesRank = 1 + byS.findIndex((t) => t === base)
  const total = list.reduce((s, t) => s + t.sales, 0)
  const share = total > 0 ? base.sales / total * 100 : null
  const byG = list.filter((t) => t.guests != null).sort((a, b) => (b.guests as number) - (a.guests as number))
  const guestsRank = base.guests != null ? 1 + byG.findIndex((t) => t === base) : null
  const byK = list.filter((t) => t.kt != null).sort((a, b) => (b.kt as number) - (a.kt as number))
  const ktRank = base.kt != null ? 1 + byK.findIndex((t) => t === base) : null
  const fcAvgSales = fcAvg(list.map((t) => t.sales))
  const fcAvgGuests = fcAvg(list.map((t) => t.guests ?? NaN).filter((v) => isFinite(v)))
  const fcAvgKt = fcAvg(list.map((t) => t.kt ?? NaN).filter((v) => isFinite(v)))
  const fcMedKt = fcMedian(list.map((t) => t.kt ?? NaN).filter((v) => isFinite(v)))
  const top = byS[0]
  const above = salesRank > 1 ? byS[salesRank - 2] : null
  const below = salesRank < byS.length ? byS[salesRank] : null

  // 自店の履歴（対象日を除く全期間）と比較
  const histAll = fcBaseDaily(reports, baseName)
  const hist = histAll.filter((r) => r.date !== date)
  const histSalesAvg = fcAvg(hist.map((r) => r.sales))
  const histGuestsAvg = fcAvg(hist.map((r) => r.guests ?? NaN).filter((v) => isFinite(v)))
  const dow = fcDow(date)
  const sameDowAvg = fcAvg(hist.filter((r) => fcDow(r.date) === dow).map((r) => r.sales))
  const rankAmongHist = 1 + hist.filter((r) => r.sales > base.sales).length

  // イベント・天気（対象日）
  const ev = (events || []).filter((e) => String(e.event_date ?? '').slice(0, 10) === date)
  const wx = (weather || []).find((w) => String(w.weather_date ?? '').slice(0, 10) === date)

  // 過去平均との差を「客数要因」「客単価要因」に分解
  let decompLine = ''
  if (base.guests != null && histGuestsAvg && histSalesAvg != null) {
    const histKtAvg = histSalesAvg / histGuestsAvg
    const diff = base.sales - histSalesAvg
    const guestEffect = (base.guests - histGuestsAvg) * histKtAvg
    const priceEffect = ((base.kt ?? histKtAvg) - histKtAvg) * base.guests
    decompLine = `過去平均との差${fcYen(diff)}の主因は「${Math.abs(guestEffect) >= Math.abs(priceEffect) ? '客数' : '客単価'}」（客数の寄与${fcYen(guestEffect)}／客単価の寄与${fcYen(priceEffect)}）。`
  }

  // 直近の推移（対象日を含む直近3日）
  const idx = histAll.findIndex((r) => r.date === date)
  const recent = idx >= 0 ? histAll.slice(Math.max(0, idx - 2), idx + 1) : []
  const trendLine = recent.length > 1 ? `直近${recent.length}日: ${recent.map((r) => `${r.date.slice(5)} ${fcYen(r.sales)}`).join(' → ')}` : ''
  let prevDiffLine = ''
  if (idx > 0) {
    const prev = histAll[idx - 1]
    const d = base.sales - prev.sales
    prevDiffLine = `前回(${prev.date.slice(5)}) ${fcYen(prev.sales)} との差 ${fcYen(d)}（${prev.sales > 0 ? fcPct(d / prev.sales * 100) : '—'}）＝${d >= 0 ? '増' : '減'}。`
  }

  const L: string[] = []
  L.push(`対象日: ${date}（${dow != null ? FC_DOW[dow] : '?'}）`)
  L.push(`売上: ${fcYen(base.sales)}（FC平均${fcAvgSales != null ? fcYen(fcAvgSales) : '—'}の${fcAvgSales ? Math.round(base.sales / fcAvgSales * 100) : '—'}%、全${list.length}店中${salesRank}位）、売上シェア${share != null ? share.toFixed(1) : '—'}%`)
  if (base.guests != null) L.push(`客数: ${base.guests}人（FC平均${fcAvgGuests != null ? Math.round(fcAvgGuests) + '人' : '—'}、${guestsRank ?? '—'}位）`)
  if (base.kt != null) L.push(`客単価: ${fcYen(base.kt)}（FC平均${fcAvgKt != null ? fcYen(fcAvgKt) : '—'}・中央値${fcMedKt != null ? fcYen(fcMedKt) : '—'}、${ktRank ?? '—'}位）`)
  if (top && top !== base) L.push(`首位: ${top.name} ${fcYen(top.sales)}（自店比${base.sales > 0 ? (top.sales / base.sales).toFixed(2) : '—'}倍）`)
  if (above || below) L.push(`順位の前後: ${above ? '上位 ' + above.name + ' ' + fcYen(above.sales) + '（+' + fcYen(above.sales - base.sales) + '）' : ''}${above && below ? ' / ' : ''}${below ? '下位 ' + below.name + ' ' + fcYen(below.sales) + '（' + fcYen(below.sales - base.sales) + '）' : ''}`)
  if (histSalesAvg != null) L.push(`自店史（対象日除く全${hist.length}日）平均比: ${histSalesAvg > 0 ? (base.sales / histSalesAvg * 100).toFixed(1) : '—'}%、履歴内順位${rankAmongHist}位`)
  if (sameDowAvg != null) L.push(`同じ曜日（${dow != null ? FC_DOW[dow] : '?'}）平均比: ${sameDowAvg > 0 ? (base.sales / sameDowAvg * 100).toFixed(1) : '—'}%`)
  L.push(ev.length ? `この日のイベント: ${ev.map((e) => `${e.category ? e.category + ':' : ''}${e.title}`).filter(Boolean).join('、')}` : `この日のイベント: なし`)
  if (wx) L.push(`天気: ${String(wx.summary ?? '') || '—'}${(wx.precipitation_mm ?? 0) >= 1 ? '（雨）' : ''}`)
  if (decompLine) L.push(decompLine)
  if (trendLine) L.push(trendLine)
  if (prevDiffLine) L.push(prevDiffLine)
  return L.join('\n')
}

// 「曜日」「東京ドームのイベント種別」「天気」ごとに、実績の平均・サンプル数・ばらつき(CV)をコードで集計する。
// 数値予測モデル(foodcourt-forecast-cron)の fit() と同じ発想＝AIには数字を作らせず、確度(サンプル数)つきの
// 客観的事実だけを渡す。LLMが自由文で記憶を書き換える方式(蓄積知見)と違い、毎回`reports`から計算し直すため
// 状態を持たず、データが増えるほど自動的に確度が上がる（＝数値予測モデルと同じ意味でのMAPE的な自己改善）。
// AI側の役割は「複数の条件が同時に成立する日にどう組み合わさるか」を多角的に判断すること（コードは単変量集計のみ）。
function buildConditionPatternStats(
  reports: Array<Record<string, unknown>>,
  baseName: string,
  events: VenueEvent[],
  weather: WeatherDay[],
): string {
  const daily = fcBaseDaily(reports, baseName).filter((r) => r.guests != null)
  if (daily.length < 5) return ''
  const overallAvg = fcAvg(daily.map((r) => r.sales)) ?? 0
  if (overallAvg <= 0) return ''
  const evByDate = new Map<string, VenueEvent[]>()
  for (const e of (events || [])) { const d = String(e.event_date ?? '').slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(d)) { if (!evByDate.has(d)) evByDate.set(d, []); evByDate.get(d)!.push(e) } }
  const wByDate = new Map<string, WeatherDay>()
  for (const w of (weather || [])) { const d = String(w.weather_date ?? '').slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(d)) wByDate.set(d, w) }
  const confidence = (n: number) => n >= 6 ? '再現性あり' : n >= 3 ? '参考程度(やや少数)' : 'サンプル僅少(参考不可)'
  const line = (label: string, xs: number[]): string | null => {
    if (xs.length < 2) return null
    const m = fcAvg(xs) ?? 0
    const sd = fcStdev(xs)
    const cv = (sd != null && m > 0) ? sd / m : null
    return `${label}: n=${xs.length} 平均${fcYen(m)}（全体比${fcPct((m / overallAvg - 1) * 100)}）ばらつきCV=${cv != null ? Math.round(cv * 100) + '%' : '—'}［${confidence(xs.length)}］`
  }
  const L: string[] = ['※n=サンプル数(3未満は参考にしない)。CV(変動係数)が大きいほど条件だけでは説明できないばらつきがある。']
  const wLines: string[] = []
  for (let d = 0; d <= 6; d++) {
    const ln = line(`${FC_DOW[d]}曜日`, daily.filter((r) => fcDow(r.date) === d).map((r) => r.sales))
    if (ln) wLines.push(ln)
  }
  if (wLines.length) L.push('[曜日別]\n' + wLines.join('\n'))
  const catBuckets = new Map<string, number[]>()
  const noneBucket: number[] = []
  for (const r of daily) {
    const evs = evByDate.get(r.date) || []
    if (!evs.length) { noneBucket.push(r.sales); continue }
    for (const c of new Set(evs.map((e) => e.category || '不明'))) { if (!catBuckets.has(c)) catBuckets.set(c, []); catBuckets.get(c)!.push(r.sales) }
  }
  const evLines: string[] = []
  for (const [cat, xs] of catBuckets) { const ln = line(cat, xs); if (ln) evLines.push(ln) }
  const noneLn = line('イベント無し', noneBucket)
  if (noneLn) evLines.push(noneLn)
  if (evLines.length) L.push('[イベント種別]\n' + evLines.sort().join('\n'))
  const rain = daily.filter((r) => { const w = wByDate.get(r.date); return w && (w.precipitation_mm ?? 0) >= 1 }).map((r) => r.sales)
  const dry = daily.filter((r) => { const w = wByDate.get(r.date); return w && (w.precipitation_mm ?? 0) < 1 }).map((r) => r.sales)
  const wxLines = [line('雨', rain), line('雨でない', dry)].filter((x): x is string => x != null)
  if (wxLines.length) L.push('[天気]\n' + wxLines.join('\n'))
  return L.length > 1 ? L.join('\n\n') : ''
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
  history: Array<{ role: string; content: string }> = [],
  forecast: ForecastRow[] = [],
  viewingDate?: string | null,
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
  const decomposition = buildContributionDecomposition(reports, baseName) // 売上=客数×客単価 の要因分解
  const storeCorr = buildStoreCorrelation(reports, baseName)               // 店舗間相関（カニバリ/アンカー）
  const anomalies = buildAnomalyDays(reports, baseName, events, weather)   // 異常値Zスコア
  const forecastCtx = buildForecastContext(forecast)                      // 学習型モデルの予測＋自己採点
  const primary = String(Deno.env.get('GROQ_CHAT_MODEL') || '').trim() || 'llama-3.3-70b-versatile'
  const fallbackModel = 'meta-llama/llama-4-scout-17b-16e-instruct'
  // 画面に表示中の単日レポートの対象日。これを渡さないと、AIは何十日分もの生データのどの日の話かを
  // 画面と無関係に(会話文脈やイベントの派手さだけで)決めてしまい、時間軸がずれた回答をする原因になる。
  const viewingBlock = viewingDate
    ? `【画面表示中の対象日・最優先で厳守】ユーザーは今、対象日=${viewingDate}のレポート画面を見ている。質問に別の日付が明示されていない限り、これが質問の対象日である。他の日のデータと混同しないこと。`
    : ''

  // --- 専門AI 2体を並列実行し、統合AIに渡す「分析メモ」を作らせる（同一プロンプト過積載を避けるための役割分担） ---
  const quantSystem = [
    `あなたは「${baseName}」（東京ドーム内フードホール「FOOD STADIUM TOKYO」の1店舗）専属の、他店舗比較と過去実績データの分析専門家です。`,
    `担当は「他店舗との関係」と「過去の実績データ」のみ。イベント・天気は別担当なので触れなくてよい。`,
    `【厳守】表の値をそのまま言い換えるだけの回答は禁止。数字は根拠として引用し、必ず「だから何を意味するか」まで述べる。`,
    `(1) 競合プロファイル（各店の業態）を使い、客単価・客数の水準がその業態から見て妥当か想定外かを判定する。`,
    `(2) 真の競合（同じ来店動機・時間帯・価格帯で客を奪い合う相手）を特定する。`,
    `(3) 売上=客数×客単価の要因分解で、動きが「客数要因」か「客単価要因」かを切り分ける。`,
    `(4) 店舗間相関（カニバリ/アンカー）を業態文脈で解釈する。ただし相関は因果ではないと明示する。`,
    `(5) 異常値（Zスコア）の突出日/落込日は平常と切り離して注記する。`,
    `(6) 来客予測モデルがあれば、自己採点(誤差%)を踏まえて参考程度に触れる。`,
    `出力は最終回答ではなく「統合担当AIへの分析メモ」。見出し＋箇条書きで簡潔に（400字程度）。`,
  ].join('\n')
  const quantUser = `${viewingBlock ? viewingBlock + '\n\n' : ''}質問: ${q}\n\n# 競合プロファイル\n${competitors}\n\n# 事前計算サマリー\n${insights || '(履歴不足)'}\n\n# 要因分解\n${decomposition || '(日数不足)'}\n\n# 店舗間相関\n${storeCorr || '(データ不足)'}\n\n# 異常値\n${anomalies || '(外れ値なし)'}\n\n# 来客予測\n${forecastCtx || '(蓄積中)'}\n\n# 日次生データ\n${data}`

  const extSystem = [
    `あなたは「${baseName}」（東京ドーム内フードホール「FOOD STADIUM TOKYO」の1店舗）専属の、会場イベント・天気の需要ドライバー分析専門家です。`,
    `担当は「東京ドームのイベント」と「天気」のみ。競合比較・過去実績の話は別担当なので触れなくてよい。`,
    `(1) 客数・売上に動きがある日は、そのイベント名・種別・規模・客層まで特定し、なぜ効いた/効かなかったかを客層・滞在時間と業態(ワイン×スパイス＝高単価大人向け)の相性で説明する。`,
    `(2) 野球は対戦相手/デーナイター、ライブはアーティスト/客層、ドームシティの小ホール(後楽園ホール・カナデビアホール等)独自の集客動機も考慮する。`,
    `(3) 天気(雨・猛暑等)とイベント有無の交互作用も見る。`,
    `(4) 今後の予定イベントがあれば、想定される影響を打ち手につながる形で触れる。`,
    `出力は最終回答ではなく「統合担当AIへの分析メモ」。見出し＋箇条書きで簡潔に（400字程度）。`,
  ].join('\n')
  const extUser = `${viewingBlock ? viewingBlock + '\n\n' : ''}質問: ${q}\n\n# 会場イベント相関\n${eventCorr || '(イベントデータなし)'}\n\n# 今後の会場イベント予定\n${eventList || '(予定データなし)'}\n\n# 天気相関\n${weatherCorr || '(天気データなし)'}\n\n# 日次生データ\n${data}`

  const [quantRes, extRes] = await Promise.all([
    groqChat([{ role: 'system', content: quantSystem }, { role: 'user', content: quantUser }], groqApiKey, primary, 700),
    groqChat([{ role: 'system', content: extSystem }, { role: 'user', content: extUser }], groqApiKey, primary, 700),
  ])
  if (quantRes.usage) await recordFoodCourtAiUsage(supabase, String(storeKey ?? ''), null, quantRes.usage)
  if (extRes.usage) await recordFoodCourtAiUsage(supabase, String(storeKey ?? ''), null, extRes.usage)
  const quantNote = quantRes.content || '(他店舗・過去データ分析メモ: 取得失敗)'
  const extNote = extRes.content || '(イベント・天気分析メモ: 取得失敗)'

  const system = [
    `あなたは「${baseName}」（東京ドーム内フードホール「FOOD STADIUM TOKYO」の1店舗）専属の、飲食業界に精通したシニア市場アナリスト兼経営コンサルタントです。`,
    `目的は「表を見れば分かる事実の再掲」ではなく、数字の“奥”を読み解いた洞察（市場調査レベルの考察）を提供することです。`,
    `【データの大前提・最重要】売上・客数は「テナント一覧＝翌朝に出る“前日”の売上比較表」由来です。ただし提供データの日付は既に『実際に売上が発生した日（売上日）』へ補正済みなので、表示された日付＝その売上が発生した実日付として扱い、それ以上ずらさないこと（重ねて前日に戻さない）。イベント・天気・曜日との連動も、その売上日の条件でそのまま解釈してよい。`,
    `【厳守・禁止】「売上は¥◯、客単価は¥◯、◯位です」のように表の値をそのまま言い換えるだけ／最大・最小をただ列挙するだけの回答は禁止。数字は根拠として最小限だけ引用し、必ず「だから何を意味するか（原因・メカニズム・顧客行動・示唆）」をセットで述べること。`,
    `【必ず市場調査として読み解く・以下を踏まえる】`,
    `(1) 競合プロファイル（各店の業態・提供する料理/飲み物・飲み中心か食事中心か）を必ず使い、“なぜその数字になるのか”を業態のメカニズムで説明する。例: 客単価の高低は業態（ワイン×スパイス＝高単価／ラーメン・ベトナム・もつ鍋＝低単価）の必然か想定外か。客数が伸びにくいのは「高単価で意思決定コストが高い業態だから」か。`,
    `(2) 顧客の利用シーン・来店動機を推定する（野球/ライブ観戦の前後の一杯、待ち時間の軽食、がっつり飯、デート・接待、インバウンド、ファミリー等）。${baseName}はどの動機を取れていて、どれを取りこぼしているか。`,
    `(3) 真の競合（代替関係）を特定する。席は共有なので“客の財布と滞在時間”の奪い合い。同じ来店動機・時間帯・価格帯で客を奪い合う相手はどの店か。同ジャンル競合の有無（ワインは自店がほぼ独占）も強み/弱みとして語る。`,
    `(4) 需要ドライバーの中でも【東京ドームのイベント】を最重要視し、具体的に深掘りする。提供データの「会場イベント相関」「直近の日別イベント（日付・客数・売上・イベント名つき）」を必ず使い、客数・売上に動きがある日は次を必ず述べる: (a) その日に**どんなイベントが・いつ（昼興行か夜公演か）あったかをイベント名・種別・規模・客層まで特定**する（例: NiziUライブ＝若年女性中心で物販・グッズ後の軽い飲食、巨人戦などプロ野球＝幅広い年齢の野球ファンで試合前後に長め滞在、大学野球＝昼開催で飲酒需要が薄い、コンサート＝開演前後に集中、等）。(b) そのイベントが${baseName}の客数・売上に**どれだけ・なぜ**効いた/効かなかったかを実数を引用してメカニズムで説明する（観客の客層・財布・滞在時間・開演時間帯と、ワイン×スパイスという高単価・大人向け業態の相性）。(c) 取り込めたイベント／取りこぼしたイベントを切り分け、次に同種のイベントが来たときの打ち手につなげる。「イベント日は客数が多い」で終わらせない。天気・曜日は補助要因として絡める。`,
    `(5) 自店の構造的な強み・弱みと打開仮説。打ち手は「誰の・どの来店動機を・どう取るか」まで具体化し、検証方法（次に何の数字を見れば効果が分かるか）も添える。`,
    `【分析フレームワーク（設計書準拠・必ず踏まえる）】`,
    `(6) 要因分解を最初に：売上＝客数×客単価。売上が動いたら必ず「客数要因」か「客単価要因」かを切り分ける（提供の「要因分解」ブロックの数値を使う）。集客が課題なら集客策、単価が課題なら単価策、と打ち手を取り違えない。`,
    `(7) 店舗間のカニバリ/アンカー：提供の「店舗間相関」を使い、負相関＝同じ来店動機の食い合い(カニバリ)候補、正相関＝連動/アンカー（人気店の集客が周辺も底上げ）候補として業態文脈で解釈する。ただし相関は因果ではない（曜日・イベント等の共通要因で連動しうる）ことを明示する。`,
    `(8) 異常値の切り分け：提供の「異常値（Zスコア）」の突出日/落込日は平常の傾向から切り離し、その日のイベント・天気で要因を注記する（外れ値で平常分析を歪めない）。`,
    `(9) イベント深掘りと交互作用：野球は対戦相手・デー/ナイター、ライブはアーティスト・客層（若年女性公演はデザート/カフェ/ドリンクの単価感度が高い等）で効き方が変わる。東京ドーム本体が無イベントでも、ドームシティの各会場（後楽園ホール＝格闘技で中年男性、プリズムホール＝展示/即売、カナデビアホール＝ライブ/舞台、ラクーア＝アイドル）が独立した来館動機になりうる点も考慮。交互作用（雨×イベント有無、猛暑×デザート/ドリンク等）も組み合わせて見る。`,
    `(10) 仮説は「支持／不支持／条件付き」で判定し、効果量（リフト率や差・倍率）を数値で添える。相関と因果は区別し、因果を主張する前に他要因（曜日・天気・イベント）を考慮する。データに無い指標（販売点数・推定来館者数による捕捉率・前年同曜日比など）は「データにありません／取得すれば精度が上がる」と明示し捏造しない。`,
    `(11) 「来客予測（学習型モデル）」がある場合は、今後の予測客数・売上を仕入・人員の助言に使う。ただしモデルの自己採点（誤差%）も併記されているので、誤差が大きい時は「精度は発展途上（データ蓄積で改善）」と断った上で参考値として扱う。`,
    `【出力スタイル】結論を先に → 根拠（数字は最小限＋競合/業態/利用シーンの文脈）→ 示唆・打ち手（具体的で検証可能な仮説）。短い見出し＋箇条書き。断定できないことは「仮説」と明示し、データに無いことは「データにありません」と述べ捏造しない。新規オープンで前年比は無いため、自店の履歴と業態特性を基準に語る。客単価の順位は業態由来なので単価の高低そのものを優劣にしない（集客＝客数で評価する）。`,
    `【会話の継続】これは継続的な対話です。直前までのやり取り（履歴）を踏まえて回答し、「その店」「それ」「さっきの」「もっと詳しく」等の指示語・省略は文脈から解決して自然に会話を続けること。前の回答と矛盾しないようにする。`,
    `【専門AIメモの統合】以下には「他店舗・過去データ分析メモ」「イベント・天気分析メモ」という、別担当の専門AIが書いた下書きが含まれる。これらは参考意見であり鵜呑みにしない。2つのメモが矛盾する場合や誇張がある場合は、必ず生データ・事前計算ブロックの数値で裏取りしてから採否を判断し、1つの一貫した最終回答にまとめること。`,
  ].join('\n')
  const contextBlock = `# データの前提（必読）\n以下の売上・客数は「テナント一覧＝翌朝発行の“前日”比較表」由来ですが、日付は既に『実際の売上日』へ補正済みです。表示された日付＝その売上が発生した実日付として扱い、これ以上ずらさず、その日のイベント・天気・曜日で解釈してください。\n\n# 競合プロファイル（FOOD STADIUM TOKYO）\n${competitors}\n\n# 事前計算サマリー（基準店）\n${insights || '(履歴不足)'}\n\n# 売上=客数×客単価 の要因分解（基準店）\n${decomposition || '(日数不足で分解不可)'}\n\n# 店舗間相関（カニバリ/アンカー・基準店 vs 各店）\n${storeCorr || '(共通日数が不足)'}\n\n# 会場イベント相関（東京ドーム）\n${eventCorr || '(イベントデータなし)'}\n\n# 今後の会場イベント予定\n${eventList || '(予定データなし)'}\n\n# 天気相関（東京ドーム周辺）\n${weatherCorr || '(天気データなし)'}\n\n# 異常値（基準店・Zスコア）\n${anomalies || '(外れ値なし/日数不足)'}\n\n# 来客予測（学習型モデル・自己採点つき）\n${forecastCtx || '(予測データなし/蓄積中)'}\n\n# 他店舗・過去データ分析メモ（専門AIの下書き）\n${quantNote}\n\n# イベント・天気分析メモ（専門AIの下書き）\n${extNote}\n\n# 日次生データ（全テナント）\n${data}`
  // 会話継続: 直前までのQ&Aを文脈として渡す（「その店は?」等の指示語が効くように）。最大8メッセージ。
  const convo: Array<{ role: string; content: string }> = []
  for (const h of (Array.isArray(history) ? history : []).slice(-8)) {
    const role = (h && h.role === 'assistant') ? 'assistant' : ((h && h.role === 'user') ? 'user' : '')
    const content = String((h && h.content) ?? '').trim().slice(0, 4000)
    if (role && content) convo.push({ role, content })
  }
  const systemFull = (viewingBlock ? viewingBlock + '\n\n' : '') + system + '\n\n# 分析の材料（この実データに基づき、直前までの会話の流れも踏まえて回答する）\n' + contextBlock
  const messages = [{ role: 'system', content: systemFull }, ...convo, { role: 'user', content: q }]
  const r1 = await groqChat(messages, groqApiKey, primary, 1800)
  let ans = r1.content
  let usage = r1.usage
  if (!ans) {
    const r2 = await groqChat(messages, groqApiKey, fallbackModel, 1800)
    ans = r2.content
    if (r2.usage) usage = r2.usage
  }
  // Q&Aの実測トークンをAI使用料に合算（best-effort・store_partition_keyで集計に乗る）。
  await recordFoodCourtAiUsage(supabase, String(storeKey ?? ''), null, usage)
  return ans
}

// 「分析サマリー（自動）」カードの1日分をAIで生成する（従来はJSテンプレートで毎回同じ言い回しだった問題への対応）。
// answerFoodCourtQuestion と同じ「専門AI2体(他店舗・過去データ／イベント・天気)を並列実行→統合AIが1本にまとめる」
// 構成を使い、対象日(targetReport)の事実(buildTargetDayFacts)を軸に語らせる。呼び出し側(admin-api)で
// report_id単位にキャッシュし、閲覧のたびに再生成しない運用を前提とする。
export async function generateFoodCourtDailySummary(
  reports: Array<Record<string, unknown>>,
  baseName: string,
  targetReport: Record<string, unknown>,
  groqApiKey: string,
  events: VenueEvent[] = [],
  weather: WeatherDay[] = [],
  forecast: ForecastRow[] = [],
  supabase?: SupabaseClient | null,
  storeKey?: string,
  priorSummary?: { businessDate: string; summaryText: string } | null,
): Promise<string | null> {
  if (!groqApiKey) return null
  canonFoodcourtReports(reports)
  const targetFacts = buildTargetDayFacts(reports, baseName, targetReport, events, weather)
  if (!targetFacts) return null
  // 前回(直近の1つ前の営業日)のAI分析を「自己検証の材料」として渡す。同じ結論を毎回繰り返すのではなく、
  // 前回の見立て（好調/不調の理由・客数要因か客単価要因か等）が今回の実績でも裏付けられたか、変わったかを
  // 一言加えさせることで、日々の分析に連続性と自己修正を持たせる（数値予測モデルの自己採点と同じ発想）。
  const priorBlock = priorSummary
    ? `# 前回（${priorSummary.businessDate}）の分析（自己検証用の材料。今回の対象日ではない）\n${priorSummary.summaryText}`
    : ''
  // 曜日/イベント種別/天気ごとの実績統計(コード計算・サンプル数と確度つき)。LLMに記憶を書かせる方式ではなく
  // 毎回reportsから計算し直すため、データが増えるほど自動的に確度が上がる（MAPE的な自己改善）。
  const patternStats = buildConditionPatternStats(reports, baseName, events, weather)
  const patternBlock = patternStats
    ? `# 統計的パターン（条件別集計・コード計算・サンプル数と確度つき）\n${patternStats}`
    : ''
  const insights = buildBaseInsights(reports, baseName)
  const eventCorr = buildEventCorrelation(reports, baseName, events)
  const eventList = buildEventListText(events)
  const weatherCorr = buildWeatherCorrelation(reports, baseName, weather)
  const competitors = buildCompetitorContext(reports, baseName)
  const decomposition = buildContributionDecomposition(reports, baseName)
  const storeCorr = buildStoreCorrelation(reports, baseName)
  const anomalies = buildAnomalyDays(reports, baseName, events, weather)
  const forecastCtx = buildForecastContext(forecast)
  const primary = String(Deno.env.get('GROQ_CHAT_MODEL') || '').trim() || 'llama-3.3-70b-versatile'
  const fallbackModel = 'meta-llama/llama-4-scout-17b-16e-instruct'

  // --- 専門AI①: 対象日の他店舗比較・過去データ分析メモ ---
  const quantSystem = [
    `あなたは「${baseName}」専属の、他店舗比較と過去実績データの分析専門家です。`,
    `担当は「対象日の他店舗との関係」と「過去の実績データとの比較」のみ。イベント・天気は別担当なので触れなくてよい。`,
    `対象日の実績・順位・シェアと、自店史（平均・同曜日平均・履歴内順位）との比較データが与えられる。`,
    `(1) 対象日の客単価・順位が業態(競合プロファイル)から見て妥当か想定外かを判定する。`,
    `(2) 真の競合（同じ来店動機・価格帯で客を奪い合う相手）の視点で、対象日の順位の意味を語る。`,
    `(3) 対象日と自店史平均の差が「客数要因」か「客単価要因」か（与えられた分解データを使う）。`,
    `(4) 対象日が自店史の中でどの程度の位置(好調/不調/平常)かを、履歴内順位・同曜日平均比で語る。`,
    `(5) 「前回の分析」が与えられている場合、そこで語った見立て（好調/不調の理由・客数要因か客単価要因か等）が今回の対象日の実績でも裏付けられたか、それとも変わったかを一言で検証する（同じ結論・同じ言い回しの繰り返しを避ける）。`,
    `(6) 「統計的パターン」が与えられている場合、これはコードが計算した客観的な集計(サンプル数n・確度つき)。対象日に該当する曜日/イベント種別/天気の複数条件を同時に参照し、それぞれの確度(nが少ない条件は割り引く)を踏まえた上で、条件同士がどう重なって効いているか(多角的に)を判断する。単一条件の数字をそのまま言い換えるだけにしない。`,
    `出力は最終回答ではなく「統合担当AIへの分析メモ」。見出し＋箇条書きで簡潔に（350字程度）。`,
  ].join('\n')
  const quantUser = `対象日の分析メモを書いてください。\n\n# 対象日の事実\n${targetFacts}\n\n# 競合プロファイル\n${competitors}\n\n# 期間サマリー（全体傾向）\n${insights || '(履歴不足)'}\n\n# 要因分解（前半→後半の全体傾向）\n${decomposition || '(日数不足)'}\n\n# 店舗間相関\n${storeCorr || '(データ不足)'}\n\n# 異常値\n${anomalies || '(外れ値なし)'}\n\n# 来客予測\n${forecastCtx || '(蓄積中)'}${patternBlock ? '\n\n' + patternBlock : ''}${priorBlock ? '\n\n' + priorBlock : ''}`

  // --- 専門AI②: 対象日のイベント・天気分析メモ ---
  const extSystem = [
    `あなたは「${baseName}」専属の、会場イベント・天気の需要ドライバー分析専門家です。`,
    `担当は「対象日の東京ドームのイベント」と「天気」のみ。競合比較・過去実績の話は別担当なので触れなくてよい。`,
    `(1) 対象日にイベントがあれば、種別・規模・客層から、なぜ客数・売上に効いた/効かなかったかを説明する。`,
    `(2) 対象日の天気(雨か否か)が客足にどう影響したかを説明する。`,
    `(3) 今後の予定イベントがあれば、次に活かせる打ち手を一言添える。`,
    `出力は最終回答ではなく「統合担当AIへの分析メモ」。見出し＋箇条書きで簡潔に（300字程度）。`,
  ].join('\n')
  const extUser = `対象日の分析メモを書いてください。\n\n# 対象日の事実\n${targetFacts}\n\n# 会場イベント相関（全体傾向）\n${eventCorr || '(イベントデータなし)'}\n\n# 今後の会場イベント予定\n${eventList || '(予定データなし)'}\n\n# 天気相関（全体傾向）\n${weatherCorr || '(天気データなし)'}`

  const [quantRes, extRes] = await Promise.all([
    groqChat([{ role: 'system', content: quantSystem }, { role: 'user', content: quantUser }], groqApiKey, primary, 600),
    groqChat([{ role: 'system', content: extSystem }, { role: 'user', content: extUser }], groqApiKey, primary, 600),
  ])
  if (quantRes.usage) await recordFoodCourtAiUsage(supabase, String(storeKey ?? ''), null, quantRes.usage)
  if (extRes.usage) await recordFoodCourtAiUsage(supabase, String(storeKey ?? ''), null, extRes.usage)
  const quantNote = quantRes.content || '(他店舗・過去データ分析メモ: 取得失敗)'
  const extNote = extRes.content || '(イベント・天気分析メモ: 取得失敗)'

  // --- 統合AI: 2つのメモ＋対象日の事実を、画面の固定7見出しフォーマットにまとめる ---
  const system = [
    `あなたは「${baseName}」（東京ドーム内フードホール「FOOD STADIUM TOKYO」の1店舗）専属の、飲食業界に精通したシニア市場アナリストです。`,
    `目的は対象日の実績について、表の値の言い換えではなく「だから何を意味するか」まで踏み込んだ日次サマリーを作ることです。`,
    `以下には「他店舗・過去データ分析メモ」「イベント・天気分析メモ」という、別担当の専門AIが書いた下書きが含まれる。これらは参考意見であり鵜呑みにしない。矛盾や誇張がある場合は「対象日の事実」ブロックの数値で裏取りしてから採否を判断する。`,
    `【前回分析の自己検証】「前回の分析」が与えられている場合、そこで語った見立て（好調/不調の理由・客数要因か客単価要因か・イベント/天気の影響など）が今回の対象日の実績でも裏付けられたか、変わったかを必ずどこかの見出し（主に【この日の評価（条件別）】か【直近の勢い】）で一言検証すること。同じ結論・同じ言い回しを毎日繰り返さない。前回との継続性がある分析にする。`,
    `【統計的パターンの多角的判断】「統計的パターン」が与えられている場合、これはコードが計算した客観的な集計(サンプル数n・確度つき)であり、AI自身が確度を判定したものではない。対象日に同時に成立する複数条件(曜日・イベント種別・天気)を横断的に見て、それぞれの確度を踏まえながら「複数の条件が重なってどう効いたか」を多角的に判断し、【この日の評価（条件別）】で言及する。nが少ない条件は「参考程度」と明示し、断定しない。`,
    `【出力フォーマット・厳守】必ず次の7つの見出しを、この順番・この表記（【】で囲む）で出力すること。見出し以外の前置き・締めの文章は書かない。`,
    `【総評】対象日の総合評価(強い/弱い/平常)を1〜2文＋根拠。`,
    `【売上】対象日の売上・FC平均比・順位を、意味づけとともに2〜3文。`,
    `【客数】対象日の客数・FC平均比・順位を、意味づけとともに1〜2文。`,
    `【客単価】対象日の客単価・FC平均比・順位を、業態文脈での意味づけとともに1〜2文。`,
    `【競合環境】自店の業態・真の競合・強みを2〜3文（対象日に限らず一般的な立ち位置の説明でよい）。`,
    `【この日の評価（条件別）】自店史平均比・同曜日平均比・履歴内順位・イベント/天気の影響・客数/客単価要因分解を2〜4文。`,
    `【直近の勢い】直近の推移・前回との差、および前回分析の自己検証結果を1〜2文。`,
    `各見出しの本文は短い文を2〜4行程度。断定できないことは「仮説」と明示し、データに無いことは「データにありません」と述べ捏造しない。客単価の順位は業態由来なので単価の高低そのものを優劣にしない。`,
  ].join('\n')
  const contextBlock = `# 対象日の事実\n${targetFacts}\n\n# 競合プロファイル\n${competitors}\n\n# 他店舗・過去データ分析メモ（専門AIの下書き）\n${quantNote}\n\n# イベント・天気分析メモ（専門AIの下書き）\n${extNote}${patternBlock ? '\n\n' + patternBlock : ''}${priorBlock ? '\n\n' + priorBlock : ''}`
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: `# 分析の材料\n${contextBlock}\n\n上記フォーマット厳守で、対象日の日次サマリーを作成してください。` },
  ]
  const r1 = await groqChat(messages, groqApiKey, primary, 1400)
  let ans = r1.content
  let usage = r1.usage
  if (!ans) {
    const r2 = await groqChat(messages, groqApiKey, fallbackModel, 1400)
    ans = r2.content
    if (r2.usage) usage = r2.usage
  }
  if (usage) await recordFoodCourtAiUsage(supabase, String(storeKey ?? ''), null, usage)
  return ans
}

export async function saveFoodCourtReport(
  supabase: SupabaseClient,
  params: { storeKey: string; roomId: string; lineMessageId: string; baseName: string; tenants: FoodCourtTenant[] },
): Promise<void> {
  try {
    // report_date＝レポート発行日（＝送信日）。テナント一覧は「前日の売上比較表」なので
    // 売上日は report_date の前日(-1)。この日付が無いと一覧フィルタ(hasReportDate)で
    // 除外され表示されないため、受信日(JST)を発行日として必ずセットする。
    // ※深夜0時またぎで送信した場合のみ1日ズレうる→分析ページから手修正できる。
    const nowJst = new Date(Date.now() + 9 * 3600 * 1000)
    const reportDate = `${nowJst.getUTCFullYear()}-${String(nowJst.getUTCMonth() + 1).padStart(2, '0')}-${String(nowJst.getUTCDate()).padStart(2, '0')}`
    await supabase.from('foodcourt_tenant_reports').upsert({
      store_partition_key: params.storeKey,
      room_id: params.roomId,
      line_message_id: params.lineMessageId,
      report_date: reportDate,
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
