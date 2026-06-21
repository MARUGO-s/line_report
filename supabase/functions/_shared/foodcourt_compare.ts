// フードコート「テナント一覧」レポート（v2.mallpro.jp）の自動解析（分析専用・売上には登録しない）。
// マルゴS等フードコート内店舗が毎日送る全テナントの売上/客数を抽出し、基準店=100の比較カードを返す。
// 安全策: ①対象店舗を限定（FOODCOURT_STORE_KEYS）②マーカー判定 ③抽出が表として成立しなければ未処理を返し
//   通常のレシート処理へフォールスルー（誤検知が売上に影響しない）。
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'

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

function tenantsFromParsed(parsed: Record<string, unknown> | null): FoodCourtTenant[] | null {
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
  return tenantsFromParsed(parseFirstJson(text))
}

// 安価な Groq(llama-4-scout) で抽出（印字されたクリーンな表向け）。失敗時は呼び出し側で Gemini にフォールバック。
export async function extractFoodCourtTenantsGroq(
  bytes: Uint8Array,
  contentType: string | null,
  groqApiKey: string,
  timeoutMs = 25000,
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
  const json = await res.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }> } | null
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

// 短い記録通知（毎回の分析結果は出さず「記録した・サイトで質問してね」だけ返す）。
export function buildFoodCourtAckFlex(n: number): Record<string, unknown> {
  return {
    type: 'flex',
    altText: 'フードコート集計を記録しました',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: '📊 フードコート集計を記録しました', weight: 'bold', size: 'md', color: '#1a6fa8' },
          { type: 'text', text: `${n}テナント分を保存（売上には登録していません）。`, size: 'sm', color: '#444444', wrap: true },
          { type: 'text', text: '分析は専用サイトで「質問」してください。蓄積データから回答します。', size: 'xs', color: '#8a96a3', wrap: true },
        ],
      },
    },
  }
}

async function groqChat(
  messages: Array<{ role: string; content: string }>,
  apiKey: string,
  model: string,
  maxTokens = 800,
): Promise<string | null> {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0.2, max_tokens: maxTokens, messages }),
    })
    if (!res.ok) { console.error('groqChat http error:', model, res.status); return null }
    const json = await res.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }> } | null
    const c = String(json?.choices?.[0]?.message?.content ?? '').trim()
    return c || null
  } catch (e) { console.error('groqChat failed:', e instanceof Error ? e.message : String(e)); return null }
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

// 蓄積されたフードコート日次データを根拠に、ユーザーの質問へ回答する（Groqテキスト／安価）。
export async function answerFoodCourtQuestion(
  reports: Array<Record<string, unknown>>,
  baseName: string,
  question: string,
  groqApiKey: string,
): Promise<string | null> {
  if (!groqApiKey) return null
  const q = String(question ?? '').trim().slice(0, 500)
  if (!q) return null
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
  const system = `あなたは「${baseName}」（フードコート内の1店舗）の経営アナリストです。次の表は同じフードコート全テナントの日次売上データ（★が基準店=${baseName}、金額は円、客単価=売上÷客数）。ユーザーの質問に、このデータだけを根拠に、日本語で簡潔に、必要な数字を添えて答えてください。データに無いことは「データにありません」と述べ、推測しない。新規オープンのため前年比は無い点に注意し、必要なら蓄積された日々の推移で答える。`
  const userMsg = `# データ\n${data}\n\n# 質問\n${q}`
  const primary = String(Deno.env.get('GROQ_CHAT_MODEL') || '').trim() || 'llama-3.3-70b-versatile'
  let ans = await groqChat([{ role: 'system', content: system }, { role: 'user', content: userMsg }], groqApiKey, primary)
  if (!ans) ans = await groqChat([{ role: 'system', content: system }, { role: 'user', content: userMsg }], groqApiKey, 'meta-llama/llama-4-scout-17b-16e-instruct')
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

  // 1) まず安価な Groq(llama-4-scout) で抽出（印字されたクリーンな表は読める想定）。
  let tenants = valid(await extractFoodCourtTenantsGroq(params.bytes, params.contentType, params.groqApiKey ?? ''))
  // 2) Groqが表として成立しない or テナント数が想定より少ない（読み落とし疑い）→ 高精度な Gemini にフォールバック。
  if ((!tenants || tenants.length < minOk) && params.geminiApiKey) {
    const g = valid(await extractFoodCourtTenants(params.bytes, params.contentType, params.geminiApiKey, params.geminiModel))
    if (g) tenants = g
  }
  if (!tenants) return { handled: false } // どちらも成立しない → 通常のレシート処理へ

  const cmp = computeFoodCourtComparison(tenants, cfg.baseTenantName)
  if (!cmp) return { handled: false }

  await saveFoodCourtReport(supabase, {
    storeKey: params.storeKey, roomId: params.roomId, lineMessageId: params.lineMessageId,
    baseName: cfg.baseTenantName, tenants,
  })
  // 毎回の分析結果は出さず、短い記録通知だけ返す（分析はサイトで質問する運用）。
  return { handled: true, reply: buildFoodCourtAckFlex(tenants.length) }
}
