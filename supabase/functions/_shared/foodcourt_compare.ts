// フードコート「テナント一覧」レポート（v2.mallpro.jp）の自動解析（分析専用・売上には登録しない）。
// マルゴS等フードコート内店舗が毎日送る全テナントの売上/客数を抽出し、基準店=100の比較カードを返す。
// 安全策: ①対象店舗を限定（FOODCOURT_STORE_KEYS）②マーカー判定 ③抽出が表として成立しなければ未処理を返し
//   通常のレシート処理へフォールスルー（誤検知が売上に影響しない）。
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'

// フードコートレポートを送ってくる店舗（基準店）。値は基準テナント名。
export const FOODCOURT_STORE_KEYS: Record<string, { baseTenantName: string }> = {
  marugoS: { baseTenantName: 'MARUGO S' },
}

// フードコート一覧らしさのマーカー（テナント表＝全テナントの対象/比較 売上・客数が並ぶ）。
const FOODCOURT_MARKERS =
  /テナント|対象売上|比較売上|売上比率|客数比率|対象客数|比較客数|mallpro|5092\d{3}/i

export type FoodCourtTenant = { name: string; code: string | null; sales: number | null; guests: number | null }

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

const EXTRACT_PROMPT = [
  'この画像はフードコートの「テナント一覧」売上レポート（各テナントの対象売上・比較売上・対象客数などが行で並ぶ表）です。',
  '表の**全テナント行**を抜き出して、JSONだけを返してください（前後に文章を付けない）。',
  '各行: name=テナント名（印字どおり）, code=テナントコード（数字。無ければnull）, sales=「対象売上」の数値, guests=「対象客数」の数値。',
  '数値はカンマ・¥・%・空白を除いた整数にする。「比較売上」「売上比率」「比較客数」「客数比率」の列は使わない（対象列だけ）。読めない数値はnull。',
  '出力形式: {"tenants":[{"name":"店名","code":"5092133","sales":496838,"guests":265}, ...]}',
].join('\n')

// 自己完結の Gemini Vision 呼び出し（テナント表を JSON 抽出）。レシート用スキーマには依存しない。
export async function extractFoodCourtTenants(
  bytes: Uint8Array,
  contentType: string | null,
  geminiApiKey: string,
  model: string,
  timeoutMs = 30000,
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
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p?.text ?? '').join('') ?? ''
  const parsed = parseFirstJson(text)
  const rawList = parsed && Array.isArray(parsed.tenants) ? parsed.tenants : null
  if (!rawList) return null
  const tenants: FoodCourtTenant[] = []
  for (const r of rawList) {
    const o = (r && typeof r === 'object') ? r as Record<string, unknown> : {}
    const name = String(o.name ?? '').trim()
    if (!name) continue
    tenants.push({
      name: name.slice(0, 60),
      code: o.code != null ? String(o.code).replace(/[^\d]/g, '').slice(0, 12) || null : null,
      sales: numOrNull(o.sales),
      guests: numOrNull(o.guests),
    })
  }
  return tenants.length ? tenants : null
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
    /** 自店レシートとして確信できない画像のとき true＝マーカー不一致でも抽出を試す（検知の取りこぼし防止）。 */
    forceAttempt?: boolean
  },
): Promise<{ handled: boolean; reply?: Record<string, unknown> }> {
  const cfg = FOODCOURT_STORE_KEYS[String(params.storeKey ?? '')]
  if (!cfg) return { handled: false }
  if (!looksLikeFoodCourtReport(params.detectText) && !params.forceAttempt) return { handled: false }
  if (!params.geminiApiKey) return { handled: false }

  const tenants = await extractFoodCourtTenants(params.bytes, params.contentType, params.geminiApiKey, params.geminiModel)
  if (!tenants || tenants.length < 3) return { handled: false } // 表として成立しない → 通常処理へ

  const cmp = computeFoodCourtComparison(tenants, cfg.baseTenantName)
  if (!cmp) return { handled: false } // 基準店が見つからない等 → 通常処理へ

  await saveFoodCourtReport(supabase, {
    storeKey: params.storeKey, roomId: params.roomId, lineMessageId: params.lineMessageId,
    baseName: cfg.baseTenantName, tenants,
  })
  return { handled: true, reply: buildFoodCourtCompareFlex(cmp) }
}
