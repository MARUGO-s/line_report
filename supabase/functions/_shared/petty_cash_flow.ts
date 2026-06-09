// 小口現金（出金/経費）の LINE 取込フロー（独立モジュール）。
// 「経費」と送る → 画像待ち → 出金レシート画像を送る → AIが本体/税を抽出 →
// 確認カード →「この内容で記録」で petty_cash_entries に記録。
// ※明示トリガー方式。売上レシート（通常送信）には一切干渉しない。
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import type { StoreRegistryRow } from './store_receipt.ts'
import type { LineImageReceiptAnalysis } from './receipt_types.ts'
import { replyLineMessages, resolveChannelAccessToken } from './line_client.ts'

const PENDING_TABLE = 'petty_cash_pending'
const ENTRIES_TABLE = 'petty_cash_entries'
const PENDING_TTL_MIN = 30
// 起動トリガー（完全一致のみ。部分一致で誤爆させない）。
const TRIGGER_WORDS = new Set(['経費', '経費登録', '出金', '出金登録', '小口', '小口登録', '小口現金'])
const CANCEL_WORDS = new Set(['キャンセル', '中止', 'やめる', 'やめ', 'cancel', 'Cancel'])
// レジ出金（＝経費の支払い）伝票のマーカー。これらを含む受領レシートは「売上」ではない。
const CASH_OUT_MARKERS = /レジ出金|出金伝票|今回出金額|出金額|現金出金|小口出金|出金処理/

export type PettyCashTextResult = { handled: boolean; replied: boolean }
export type PettyCashImageResult = { handled: boolean; replied: boolean; saved?: boolean; reason?: string }

function conversationKey(roomId: string, userId: string | null): string {
  return `${roomId || '__unknown_room__'}::${userId || '__anonymous__'}`
}

function formatYen(n: number): string {
  return '¥' + Math.round(Math.max(0, n)).toLocaleString('en-US')
}

// "¥1,234" / "1234円" → 1234（数字のみ抽出）。読めなければ null。
function parseYenToInt(s: unknown): number | null {
  if (s == null) return null
  const digits = String(s).replace(/[^\d]/g, '')
  if (!digits) return null
  const n = Number(digits)
  return Number.isFinite(n) ? n : null
}

// 各種日付表記 → "YYYY-MM-DD"。読めなければ null。
function normalizeDateYmd(s: unknown): string | null {
  if (s == null) return null
  const t = String(s).trim()
  const m = t.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/)
  if (!m) return null
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function todayYmdJst(): string {
  const j = new Date(Date.now() + 9 * 3600 * 1000)
  return `${j.getUTCFullYear()}-${String(j.getUTCMonth() + 1).padStart(2, '0')}-${String(j.getUTCDate()).padStart(2, '0')}`
}

// レシート解析結果 → 経費フィールド（出金額/税/日付/品目/仕入先）。金額不読は null。
// 出金額=税込合計(grossSales)／無ければ 税抜(netSales)+税。税=taxAmount。
function extractExpenseFromReceipt(
  receipt: LineImageReceiptAnalysis | null,
): { amount: number; tax: number; spentOn: string; item: string; supplier: string | null } | null {
  const tax = parseYenToInt(receipt?.taxAmount) ?? 0
  const gross = parseYenToInt(receipt?.grossSales)
  const net = parseYenToInt(receipt?.netSales)
  // 商品明細（品名＋価格）。価格は数値化。
  const lineItems = Array.isArray(receipt?.lineItems) ? receipt!.lineItems! : []
  const itemRows = lineItems
    .map((li) => ({ name: li?.name ? String(li.name).trim() : '', amount: parseYenToInt(li?.price) }))
    .filter((x) => x.name || x.amount != null)
    .slice(0, 10)
  const itemsSum = itemRows.reduce((s, i) => s + (i.amount != null && i.amount > 0 ? i.amount : 0), 0)

  // 本体(税抜)・出金額(税込)の決定（誤読対策）:
  //  小計(net)+税(tax) が最優先（外税/内税どちらも税込合計に一致、お預りと混同しない）。
  //  次に 明細合計(itemsSum, 外税前提で +tax)＝合計が「お預り」と誤読されるのを避ける。最後に 合計(gross)。
  let base: number | null = null
  let amount: number | null = null
  if (net != null && net > 0) { base = net; amount = net + tax }
  else if (itemsSum > 0) { base = itemsSum; amount = itemsSum + tax }
  else if (gross != null && gross > 0) { amount = gross; base = Math.max(0, gross - tax) }
  if (base == null || amount == null || amount <= 0) return null
  const safeTax = Math.min(tax, amount)
  const spentOn = normalizeDateYmd(receipt?.date) ?? todayYmdJst()
  const supplier = receipt?.storeName ? String(receipt.storeName).trim() : null

  // 品目テキスト: 明細があれば「・品名 ¥価格」を1行ずつ。無ければ items(品名のみ)。
  let item: string
  if (itemRows.length) {
    item = itemRows.map((i) => `・${i.name}${i.amount != null ? ' ' + formatYen(i.amount) : ''}`.trim()).join('\n')
  } else {
    const nameItems = Array.isArray(receipt?.items) ? receipt!.items.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 8) : []
    item = nameItems.length > 1 ? nameItems.map((s) => '・' + s).join('\n') : (nameItems[0] || supplier || '経費')
  }
  return { amount, tax: safeTax, spentOn, item, supplier }
}

function textMessage(text: string): Record<string, unknown> {
  return { type: 'text', text }
}

function guideFlex(storeName: string): Record<string, unknown> {
  return {
    type: 'flex',
    altText: '経費（小口現金）の取込',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: '経費（小口現金）として記録', weight: 'bold', size: 'lg', color: '#1a6fa8', wrap: true },
          { type: 'text', text: `店舗：${storeName}`, size: 'sm', color: '#444444', wrap: true },
          { type: 'text', text: '続けて、出金（経費）レシートの画像を送ってください。AIが本体価格・税額を読み取り、確認のうえ小口現金に記録します。', size: 'sm', color: '#444444', wrap: true },
          { type: 'text', text: '※これは「売上」には登録されません。やめる場合は下の「キャンセル」。', size: 'xs', color: '#8a96a3', wrap: true },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: 'キャンセル', text: 'キャンセル' } },
        ],
      },
    },
  }
}

function fieldRows(rows: Array<[string, string | null]>): Record<string, unknown>[] {
  return rows.filter(([, v]) => v && String(v).trim()).map(([label, v]) => ({
    type: 'box', layout: 'baseline', spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#8a96a3', flex: 2 },
      { type: 'text', text: String(v), size: 'sm', color: '#333333', flex: 5, wrap: true },
    ],
  }))
}

type ExtractedExpense = {
  storeDisplayName: string
  spentOn: string
  item: string | null
  amount: number
  tax: number
  supplier: string | null
}

function confirmFlex(pendingId: number, x: ExtractedExpense): Record<string, unknown> {
  const base = Math.max(0, x.amount - x.tax)
  return {
    type: 'flex',
    altText: `経費の記録確認: ${x.item ?? ''} ${formatYen(x.amount)}`.slice(0, 380),
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: '小口現金に記録しますか？', weight: 'bold', size: 'md', color: '#1a6fa8' },
          { type: 'text', text: '出金（経費）レシートを読み取りました。内容を確認して記録してください。', wrap: true, size: 'xs', color: '#8a96a3' },
          { type: 'separator', margin: 'md' },
          ...fieldRows([
            ['店舗', x.storeDisplayName],
            ['日付', x.spentOn],
            ['仕入先', x.supplier],
            ['品目', x.item],
            ['本体', formatYen(base)],
            ['税額', x.tax > 0 ? formatYen(x.tax) : '—'],
            ['出金額', formatYen(x.amount)],
          ]),
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#1a6fa8', action: { type: 'postback', label: 'この内容で記録', data: `pcimp=${pendingId}`, displayText: '小口現金に記録します' } },
          { type: 'button', style: 'secondary', action: { type: 'postback', label: '破棄（記録しない）', data: `pcimp_skip=${pendingId}`, displayText: '経費の記録を取りやめます' } },
        ],
      },
    },
  }
}

function simpleNoticeFlex(text: string): Record<string, unknown> {
  return {
    type: 'flex',
    altText: text.slice(0, 380),
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text, wrap: true, size: 'sm', color: '#333333' }] },
    },
  }
}

// レジ出金（経費）伝票を検知したときの案内カード（売上に登録せず、経費記録へ誘導）。
function cashOutOfferFlex(pendingId: number, amount: number): Record<string, unknown> {
  return {
    type: 'flex',
    altText: 'レジ出金（経費）の伝票',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: 'レジ出金（経費）の伝票のようです', weight: 'bold', size: 'md', color: '#1a6fa8', wrap: true },
          { type: 'text', text: `これは「売上」ではないため、売上には登録していません。出金額 ${formatYen(amount)} を小口現金（経費）として記録できます。`, size: 'sm', color: '#444444', wrap: true },
          { type: 'text', text: '※「記録」を押すと内容確認カードが出ます。', size: 'xs', color: '#8a96a3', wrap: true },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#1a6fa8', height: 'sm', action: { type: 'postback', label: '経費（小口）として記録', data: `pcreview=${pendingId}`, displayText: '経費（小口）として記録します' } },
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '了解（記録しない）', text: '了解' } },
        ],
      },
    },
  }
}

function doneFlex(p: PendingRow): Record<string, unknown> {
  const amount = Math.max(0, Math.floor(Number(p.amount_yen ?? 0)))
  const tax = Math.max(0, Math.floor(Number(p.tax_yen ?? 0)))
  const base = Math.max(0, amount - tax)
  return {
    type: 'flex',
    altText: '小口現金に記録しました',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: '✅ 小口現金に記録しました', weight: 'bold', size: 'md', color: '#1a7f37' },
          { type: 'separator', margin: 'md' },
          ...fieldRows([
            ['日付', p.spent_on],
            ['品目', p.item],
            ['本体', formatYen(base)],
            ['税額', tax > 0 ? formatYen(tax) : '—'],
            ['出金額', formatYen(amount)],
          ]),
          { type: 'text', text: '小口現金ページ（出金・経費）に反映されます。', size: 'xs', color: '#8a96a3', margin: 'md', wrap: true },
        ],
      },
    },
  }
}

type PendingRow = {
  id: number
  status: string
  store_partition_key: string | null
  line_message_id: string | null
  spent_on: string | null
  item: string | null
  amount_yen: number | null
  tax_yen: number | null
  handler: string | null
  store_name: string | null
  category: string | null
}

async function clearPending(supabase: SupabaseClient, key: string): Promise<void> {
  try { await supabase.from(PENDING_TABLE).delete().eq('conversation_key', key) } catch (_e) { /* noop */ }
}

async function sendReply(
  replyToken: string,
  messages: Record<string, unknown>[],
  storeKey: string,
  roomId: string,
): Promise<boolean> {
  const accessToken = resolveChannelAccessToken(storeKey)
  if (!replyToken || !accessToken) return false
  try {
    const r = await replyLineMessages(replyToken, messages, accessToken, {
      storePartitionKey: storeKey,
      context: 'petty_cash',
      roomId,
    })
    return r.ok
  } catch (_e) { return false }
}

// テキスト処理: 「経費」で画像待ちに、pending中の「キャンセル」で中止。それ以外は従来処理へフォールスルー。
export async function handlePettyCashTextMessage(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  args: { roomId: string; userId: string | null; replyToken: string; text: string },
): Promise<PettyCashTextResult> {
  const { roomId, userId, replyToken, text } = args
  const isTrigger = TRIGGER_WORDS.has(text)
  const isCancel = CANCEL_WORDS.has(text)
  if (!isTrigger && !isCancel) return { handled: false, replied: false }

  const key = conversationKey(roomId, userId)
  const storeKey = String(registry.store_partition_key ?? '').trim()
  const storeName = String(registry.display_name ?? '').trim() || storeKey

  if (isCancel) {
    // 経費pendingがある時だけ中止を引き受ける（無ければ従来処理へ）。
    const { data } = await supabase.from(PENDING_TABLE).select('status').eq('conversation_key', key).maybeSingle()
    const st = String((data as { status?: unknown } | null)?.status ?? '')
    if (st !== 'await_image' && st !== 'await_confirm') return { handled: false, replied: false }
    await clearPending(supabase, key)
    const replied = await sendReply(replyToken, [textMessage('経費（小口現金）の記録を中止しました。')], storeKey, roomId)
    return { handled: true, replied }
  }

  // トリガー: 画像待ちに設定（既存pendingは上書き）。
  const nowIso = new Date().toISOString()
  const expiresAt = new Date(Date.now() + PENDING_TTL_MIN * 60 * 1000).toISOString()
  const { error } = await supabase.from(PENDING_TABLE).upsert({
    conversation_key: key,
    room_id: roomId,
    user_id: userId || null,
    store_partition_key: storeKey || null,
    status: 'await_image',
    line_message_id: null,
    spent_on: null, item: null, amount_yen: null, tax_yen: null, handler: null, store_name: null, category: null,
    expires_at: expiresAt,
    updated_at: nowIso,
  }, { onConflict: 'conversation_key' })
  if (error) {
    const replied = await sendReply(replyToken, [textMessage('経費の受付を開始できませんでした。少し時間を置いて「経費」と送り直してください。')], storeKey, roomId)
    return { handled: true, replied }
  }
  const replied = await sendReply(replyToken, [guideFlex(storeName)], storeKey, roomId)
  return { handled: true, replied }
}

// 画像処理: 経費pending(await_image)があれば、この画像を経費として扱う（売上に登録しない）。
// pending が無ければ {handled:false} を返し、従来のレシート処理へフォールスルー。
export async function handlePettyCashImageIfPending(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  args: { roomId: string; userId: string | null; replyToken: string; lineMessageId: string; receipt: LineImageReceiptAnalysis | null; summary: string; reanalyze?: () => Promise<LineImageReceiptAnalysis | null> },
): Promise<PettyCashImageResult> {
  const { roomId, userId, replyToken, lineMessageId, receipt } = args
  const key = conversationKey(roomId, userId)
  const storeKey = String(registry.store_partition_key ?? '').trim()
  const storeName = String(registry.display_name ?? '').trim() || storeKey

  const { data } = await supabase
    .from(PENDING_TABLE)
    .select('id, status, expires_at')
    .eq('conversation_key', key)
    .maybeSingle()
  if (!data) return { handled: false, replied: false }
  const status = String((data as { status?: unknown }).status ?? '')
  if (status !== 'await_image') return { handled: false, replied: false }
  const exp = String((data as { expires_at?: unknown }).expires_at ?? '')
  if (exp && Date.parse(exp) <= Date.now()) {
    await clearPending(supabase, key)
    return { handled: false, replied: false }
  }
  const pendingId = Number((data as { id?: unknown }).id ?? 0)

  // 経費専用に再解析（明細・小計/外税を取得）。失敗時のみ売上解析をフォールバック。売上(精算)解析には非依存。
  const receiptForExpense = (args.reanalyze ? await args.reanalyze() : null) ?? receipt
  const ex = extractExpenseFromReceipt(receiptForExpense)
  if (!ex) {
    await clearPending(supabase, key)
    const replied = await sendReply(replyToken, [simpleNoticeFlex('レシートの金額を読み取れませんでした。お手数ですが小口現金ページから手入力してください。')], storeKey, roomId)
    return { handled: true, replied, saved: false, reason: 'petty_cash_amount_unreadable' }
  }

  await supabase.from(PENDING_TABLE).update({
    status: 'await_confirm',
    line_message_id: lineMessageId,
    spent_on: ex.spentOn,
    item: ex.item,
    amount_yen: ex.amount,
    tax_yen: ex.tax,
    store_name: ex.supplier,
    updated_at: new Date().toISOString(),
  }).eq('id', pendingId)

  const replied = await sendReply(replyToken, [confirmFlex(pendingId, {
    storeDisplayName: storeName, spentOn: ex.spentOn, item: ex.item, amount: ex.amount, tax: ex.tax, supplier: ex.supplier,
  })], storeKey, roomId)
  return { handled: true, replied, saved: false, reason: 'petty_cash_confirm_card' }
}

// 店名不一致などで売上登録されなかったレシートを「経費候補」として pending(await_confirm) に保存し、
// 確認ボタン用の pendingId を返す（金額不読なら null＝ボタンを出さない）。
// これで「経費」と先に打たなくても、画像→不一致カードの「経費として記録」ボタンで小口記録できる。
export async function savePettyCashPendingFromReceipt(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  args: { roomId: string; userId: string | null; lineMessageId: string; receipt: LineImageReceiptAnalysis | null; reanalyze?: () => Promise<LineImageReceiptAnalysis | null> },
): Promise<number | null> {
  const { roomId, userId, lineMessageId, receipt } = args
  // 経費専用に再解析（明細・小計/外税）。失敗時のみ売上解析をフォールバック。
  const receiptForExpense = (args.reanalyze ? await args.reanalyze() : null) ?? receipt
  const ex = extractExpenseFromReceipt(receiptForExpense)
  if (!ex) return null
  const storeKey = String(registry.store_partition_key ?? '').trim()
  const key = conversationKey(roomId, userId)
  const nowIso = new Date().toISOString()
  const expiresAt = new Date(Date.now() + PENDING_TTL_MIN * 60 * 1000).toISOString()
  const { data, error } = await supabase.from(PENDING_TABLE).upsert({
    conversation_key: key,
    room_id: roomId,
    user_id: userId || null,
    store_partition_key: storeKey || null,
    status: 'await_confirm',
    line_message_id: lineMessageId,
    spent_on: ex.spentOn,
    item: ex.item,
    amount_yen: ex.amount,
    tax_yen: ex.tax,
    handler: null,
    store_name: ex.supplier,
    category: null,
    expires_at: expiresAt,
    updated_at: nowIso,
  }, { onConflict: 'conversation_key' }).select('id').single()
  if (error) {
    console.error('savePettyCashPendingFromReceipt failed:', error.message)
    return null
  }
  return Number((data as { id?: number } | null)?.id ?? 0) || null
}

// レジ出金（経費）伝票の検知。売上ではないので売上登録せず、経費記録を案内する。
// 検知しなければ {handled:false}（従来の売上処理へフォールスルー）。
export async function handlePettyCashCashOutSlip(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  args: { roomId: string; userId: string | null; replyToken: string; lineMessageId: string; receipt: LineImageReceiptAnalysis | null; summary: string; reanalyze?: () => Promise<LineImageReceiptAnalysis | null> },
): Promise<PettyCashImageResult> {
  const { roomId, userId, replyToken, lineMessageId, receipt, summary, reanalyze } = args
  // 検知は売上解析の summary/items（レジ出金マーカー）で行う。
  const haystack = `${summary ?? ''} ${(Array.isArray(receipt?.items) ? receipt!.items.join(' ') : '')}`
  if (!CASH_OUT_MARKERS.test(haystack)) return { handled: false, replied: false }

  // 出金伝票＝売上ではない。以降は売上登録しない（handled:true で確定）。
  // 金額・明細は経費専用に再解析（売上解析プロンプトには非依存）。失敗時のみ売上解析をフォールバック。
  const storeKey = String(registry.store_partition_key ?? '').trim()
  const exReceipt = (reanalyze ? await reanalyze() : null) ?? receipt
  const pendingId = await savePettyCashPendingFromReceipt(supabase, registry, { roomId, userId, lineMessageId, receipt: exReceipt })
  if (!pendingId) {
    const replied = await sendReply(replyToken, [simpleNoticeFlex('レジ出金（経費）の伝票のようです。売上には登録していません。金額が読み取れなかったため、小口現金ページから手入力してください。')], storeKey, roomId)
    return { handled: true, replied, saved: false, reason: 'petty_cash_cashout_unreadable' }
  }
  const ex = extractExpenseFromReceipt(exReceipt)
  const replied = await sendReply(replyToken, [cashOutOfferFlex(pendingId, ex?.amount ?? 0)], storeKey, roomId)
  return { handled: true, replied, saved: false, reason: 'petty_cash_cashout_offer' }
}

// 確認カードの postback。
//   pcreview=<id>   … 解析結果の確認カードを表示（記録しない）。不一致カードの「経費として記録」から来る。
//   pcimp=<id>      … この内容で記録（petty_cash_entries へ）
//   pcimp_skip=<id> … 破棄
export async function handlePettyCashPostback(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  postbackData: string,
): Promise<Record<string, unknown> | null> {
  const isReview = postbackData.startsWith('pcreview=')
  const isRecord = postbackData.startsWith('pcimp=')
  const isSkip = postbackData.startsWith('pcimp_skip=')
  if (!isReview && !isRecord && !isSkip) return null
  const id = Number(postbackData.split('=')[1] ?? '')
  if (!Number.isInteger(id) || id <= 0) return null

  const { data: pending, error } = await supabase
    .from(PENDING_TABLE)
    .select('id, status, store_partition_key, line_message_id, spent_on, item, amount_yen, tax_yen, handler, store_name, category')
    .eq('id', id)
    .maybeSingle()
  if (error || !pending) return simpleNoticeFlex('対象の経費が見つかりませんでした。')
  const p = pending as PendingRow

  if (p.status === 'recorded') return simpleNoticeFlex('この経費はすでに記録済みです。')
  if (p.status !== 'await_confirm') return simpleNoticeFlex('この経費は無効です。レシートを送り直すか「経費」と送ってやり直してください。')

  // 解析結果の確認カードを表示（記録はしない）。
  if (isReview) {
    const storeName = String(registry.display_name ?? '').trim() || String(p.store_partition_key ?? '')
    return confirmFlex(p.id, {
      storeDisplayName: storeName,
      spentOn: p.spent_on ?? '',
      item: p.item,
      amount: Math.max(0, Math.floor(Number(p.amount_yen ?? 0))),
      tax: Math.max(0, Math.floor(Number(p.tax_yen ?? 0))),
      supplier: p.store_name,
    })
  }

  // 破棄
  if (isSkip) {
    await supabase.from(PENDING_TABLE).update({ status: 'dismissed', updated_at: new Date().toISOString() }).eq('id', id)
    return simpleNoticeFlex('経費の記録を取りやめました。')
  }

  // 記録（pcimp）
  const amount = Math.max(0, Math.floor(Number(p.amount_yen ?? 0)))
  const tax = Math.min(amount, Math.max(0, Math.floor(Number(p.tax_yen ?? 0))))
  if (!p.store_partition_key || !p.spent_on || amount <= 0) {
    return simpleNoticeFlex('記録に必要な情報が不足しています。小口現金ページから手入力してください。')
  }

  const { error: insErr } = await supabase.from(ENTRIES_TABLE).insert({
    store_partition_key: p.store_partition_key,
    spent_on: p.spent_on,
    item: p.item,
    category: p.category,
    amount_yen: amount,
    tax_yen: tax,
    handler: p.handler,
    note: p.store_name ? ('仕入先: ' + p.store_name) : null,
    source: 'line_image',
    line_message_id: p.line_message_id,
  })
  if (insErr) {
    // line_message_id 一意制約などの重複は「記録済み」とみなす。
    console.error('petty_cash insert failed:', insErr.message)
    await supabase.from(PENDING_TABLE).update({ status: 'recorded', updated_at: new Date().toISOString() }).eq('id', id)
    return simpleNoticeFlex('この経費はすでに記録済みのようです。小口現金ページをご確認ください。')
  }
  await supabase.from(PENDING_TABLE).update({ status: 'recorded', updated_at: new Date().toISOString() }).eq('id', id)
  return doneFlex(p)
}
