// 予算登録フロー（独立モジュール）。
// LINEルームで「予算登録」と送ると、対象年月→予算額の順にFlexで聞き返し、
// line_sales_month_budgets に upsert する。会話状態は store_budget_entry_pending に保持。
// 既存のレシート/予約/検索/解析の処理には一切干渉しない（このフロー専用）。
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import type { StoreRegistryRow } from './store_receipt.ts'
import { replyLineMessages, resolveChannelAccessToken } from './line_client.ts'
import { issueAdminDashboardLoginLinkToken, RECEIPT_ANALYTICS_SCOPE } from './admin_dashboard_link_auth.ts'
import { buildReceiptAnalyticsDashboardUri } from './receipt_line_actions.ts'

const PENDING_TABLE = 'store_budget_entry_pending'
const BUDGET_TABLE = 'line_sales_month_budgets'
const PENDING_TTL_MIN = 30
// 起動トリガー（完全一致のみ。部分一致で誤爆させない）。
const TRIGGER_WORDS = new Set(['予算登録', '予算入力', '予算設定'])
const CANCEL_WORDS = new Set(['キャンセル', '中止', 'やめる', 'やめ', 'cancel', 'Cancel'])
const MAX_BUDGET_YEN = 100_000_000_000 // 1000億上限（誤入力ガード）
const OVERWRITE_WORDS = new Set(['上書き保存', '上書き', '上書きする', 'はい', 'OK', 'ok'])

// 完了カードの注意喚起（月間総額のみ／次に管理画面で曜日重み・休日を登録／その意味）。
const BUDGET_NOTICE_LINES = [
  'いまLINEで登録したのは「月間の総予算額」だけです。',
  '続けて管理画面（売上分析ページ）で、この月の【曜日ごとの重み付け】と【店休日・休前日・祝日】も登録してください。',
  '〔なぜ必要か〕曜日の重みと休日を入れると、月間総額が日割りに正しく配分されます（例：金土・休前日は高め、定休日は0）。これで毎日の売上進捗・着地予測・中間／月末レポートが実態に合った数字になります。未設定だと毎日が均等割りのままで、目標がズレます。',
]

type Step = 'await_month' | 'await_amount' | 'await_overwrite_confirm'

function conversationKey(roomId: string, userId: string | null): string {
  return `${roomId || '__unknown_room__'}::${userId || '__anonymous__'}`
}

function budgetFlex(
  title: string,
  lines: string[],
  color = '#1F6FEB',
  withCancel = false,
): Record<string, unknown> {
  const bubble: Record<string, unknown> = {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        { type: 'text', text: title, weight: 'bold', size: 'lg', wrap: true, color },
        ...lines.map((t) => ({ type: 'text', text: t, wrap: true, size: 'sm', color: '#444444' })),
      ],
    },
  }
  if (withCancel) {
    // 「キャンセル」ボタン＝テキスト「キャンセル」を送信するだけ（既存の中止処理が拾う）。webhook変更不要。
    bubble.footer = {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'button',
          style: 'secondary',
          height: 'sm',
          action: { type: 'message', label: 'キャンセル', text: 'キャンセル' },
        },
      ],
    }
  }
  return { type: 'flex', altText: title, contents: bubble }
}

// 登録完了カード：月間総額の登録結果＋「次に管理画面で曜日重み・休日を登録」の注意喚起＋
// その店舗の売上分析ページへ飛ぶボタン（ワンタイムログイントークン付きURL）。
function budgetDoneFlex(
  title: string,
  summaryLines: string[],
  noticeLines: string[],
  dashboardUri: string,
): Record<string, unknown> {
  const body: Record<string, unknown>[] = [
    { type: 'text', text: title, weight: 'bold', size: 'lg', wrap: true, color: '#1F8A4C' },
    ...summaryLines.map((t) => ({ type: 'text', text: t, wrap: true, size: 'sm', color: '#444444' })),
    { type: 'separator', margin: 'lg' },
    { type: 'text', text: '⚠️ 次にやること（重要）', weight: 'bold', size: 'sm', wrap: true, color: '#C2410C', margin: 'lg' },
    ...noticeLines.map((t) => ({ type: 'text', text: t, wrap: true, size: 'sm', color: '#555555' })),
  ]
  const bubble: Record<string, unknown> = {
    type: 'bubble',
    size: 'mega',
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body },
  }
  if (dashboardUri) {
    bubble.footer = {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        {
          type: 'button',
          style: 'primary',
          height: 'sm',
          color: '#1F8A4C',
          action: { type: 'uri', label: 'この店舗の売上分析ページを開く', uri: dashboardUri },
        },
        {
          type: 'text',
          text: '※リンクはログイン用ワンタイムパスワード付き（一定時間で失効）',
          size: 'xxs',
          color: '#999999',
          wrap: true,
          align: 'center',
        },
      ],
    }
  }
  return { type: 'flex', altText: title, contents: bubble }
}

function formatYen(n: number): string {
  return '¥' + Math.round(n).toLocaleString('en-US')
}

async function clearPending(supabase: SupabaseClient, key: string): Promise<void> {
  try {
    await supabase.from(PENDING_TABLE).delete().eq('conversation_key', key)
  } catch (_e) { /* noop */ }
}

// 既存予算/過去売上があるときの確認カード（「上書き保存」「キャンセル」の2ボタン）。
function budgetConfirmFlex(title: string, lines: string[]): Record<string, unknown> {
  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: title, weight: 'bold', size: 'lg', wrap: true, color: '#C2410C' },
          ...lines.map((t) => ({ type: 'text', text: t, wrap: true, size: 'sm', color: '#444444' })),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            height: 'sm',
            color: '#1F8A4C',
            action: { type: 'message', label: '上書き保存', text: '上書き保存' },
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: { type: 'message', label: 'キャンセル', text: 'キャンセル' },
          },
        ],
      },
    },
  }
}

// 予算を line_sales_month_budgets に upsert し、pendingを消して完了カード（注意喚起＋OTP分析ボタン）を返す。
async function commitBudgetAndReply(
  supabase: SupabaseClient,
  key: string,
  budgetStoreKey: string,
  urlStoreKey: string,
  storeName: string,
  targetMonth: string,
  amount: number,
  existed: boolean,
  reply: (flex: Record<string, unknown>) => Promise<boolean>,
): Promise<boolean> {
  const nowIso = new Date().toISOString()
  const { error } = await supabase.from(BUDGET_TABLE).upsert({
    store_partition_key: budgetStoreKey,
    target_month: targetMonth,
    budget_yen: amount,
    updated_at: nowIso,
  }, { onConflict: 'store_partition_key,target_month' })
  await clearPending(supabase, key)
  if (error) {
    return reply(budgetFlex('登録に失敗しました', [
      '少し時間を置いて、もう一度「予算登録」からお願いします。',
      `(${error.message.slice(0, 80)})`,
    ], '#D14343'))
  }
  let dashboardUri = ''
  try {
    const issued = await issueAdminDashboardLoginLinkToken(supabase, {
      source: 'line_budget_entry',
      store_partition_key: budgetStoreKey,
      target_month: targetMonth,
      scope: RECEIPT_ANALYTICS_SCOPE,
    })
    dashboardUri = buildReceiptAnalyticsDashboardUri(urlStoreKey, targetMonth, { loginToken: issued.token })
  } catch (_e) {
    try {
      dashboardUri = buildReceiptAnalyticsDashboardUri(urlStoreKey, targetMonth)
    } catch (_e2) {
      dashboardUri = ''
    }
  }
  const [yy, mo] = targetMonth.split('-')
  return reply(budgetDoneFlex(
    existed ? '✅ 予算を更新しました' : '✅ 予算を登録しました',
    [
      `店舗：${storeName}`,
      `対象月：${Number(yy)}年${Number(mo)}月`,
      `月間総予算：${formatYen(amount)}`,
    ],
    BUDGET_NOTICE_LINES,
    dashboardUri,
  ))
}

/**
 * テキストメッセージを予算登録フローとして処理する。
 * - 「予算登録」等のトリガー、または当人(room+user)に予算pendingがある時だけ作動。
 * - それ以外は { handled:false } を返し、呼び出し側は従来処理にフォールスルーする。
 */
export async function handleBudgetEntryTextMessage(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  params: { roomId: string; userId: string; replyToken: string; text: string },
): Promise<{ handled: boolean; replied: boolean }> {
  const roomId = String(params.roomId ?? '').trim()
  const userId = String(params.userId ?? '').trim()
  const replyToken = String(params.replyToken ?? '').trim()
  const text = String(params.text ?? '').trim()
  if (!roomId || !text) return { handled: false, replied: false }

  const key = conversationKey(roomId, userId)
  const storeKey = String(registry?.store_partition_key ?? '').trim()
  // 予算テーブル(line_sales_month_budgets)は admin が小文字キーで読み書きする(normalizeBudgetStoreKey)。
  // 大文字を含む店舗キー(marugoD等)で別行にならないよう、予算行のキーは小文字に揃える。
  const budgetStoreKey = storeKey.toLowerCase()
  const storeName = String(registry?.display_name ?? '').trim() || storeKey
  const isTrigger = TRIGGER_WORDS.has(text)

  // 既存のpendingを読む（期限切れは破棄）。
  let pending: { step: Step; target_month: string | null; budget_yen: number | null } | null = null
  {
    const { data } = await supabase
      .from(PENDING_TABLE)
      .select('step, target_month, budget_yen, expires_at')
      .eq('conversation_key', key)
      .maybeSingle()
    if (data) {
      const exp = String((data as { expires_at?: unknown }).expires_at ?? '')
      if (exp && Date.parse(exp) <= Date.now()) {
        await clearPending(supabase, key)
      } else {
        const rawBudget = (data as { budget_yen?: unknown }).budget_yen
        pending = {
          step: String((data as { step?: unknown }).step ?? '') as Step,
          target_month: (data as { target_month?: unknown }).target_month != null
            ? String((data as { target_month?: unknown }).target_month)
            : null,
          budget_yen: rawBudget != null && Number.isFinite(Number(rawBudget)) ? Number(rawBudget) : null,
        }
      }
    }
  }

  // 予算フローでない（トリガーでもなく、pendingも無い）→ 何もしない＝従来処理へフォールスルー。
  if (!isTrigger && !pending) return { handled: false, replied: false }

  const accessToken = resolveChannelAccessToken(storeKey)
  const reply = async (flex: Record<string, unknown>): Promise<boolean> => {
    if (!replyToken || !accessToken) return false
    const r = await replyLineMessages(replyToken, [flex], accessToken, {
      storePartitionKey: storeKey,
      context: 'budget_entry',
      roomId,
    })
    return r.ok
  }

  // 中止
  if (pending && CANCEL_WORDS.has(text)) {
    await clearPending(supabase, key)
    const replied = await reply(budgetFlex(
      '予算登録を中止しました',
      ['もう一度始めるには「予算登録」と送ってください。'],
      '#888888',
    ))
    return { handled: true, replied }
  }

  // 開始（トリガー）: 既存pendingがあっても上書きして「月待ち」から始める。
  if (isTrigger) {
    const nowIso = new Date().toISOString()
    const expiresAt = new Date(Date.now() + PENDING_TTL_MIN * 60 * 1000).toISOString()
    const { error } = await supabase.from(PENDING_TABLE).upsert({
      conversation_key: key,
      room_id: roomId,
      user_id: userId || null,
      store_partition_key: storeKey,
      step: 'await_month',
      target_month: null,
      expires_at: expiresAt,
      updated_at: nowIso,
    }, { onConflict: 'conversation_key' })
    if (error) {
      const replied = await reply(budgetFlex(
        '予算登録を開始できませんでした',
        ['少し時間を置いて「予算登録」と送り直してください。'],
        '#D14343',
      ))
      return { handled: true, replied }
    }
    const replied = await reply(budgetFlex('予算登録：対象の年月は？', [
      `店舗：${storeName}`,
      '登録する西暦と月を「6桁」で送ってください。',
      '例）2026年6月 → 202606',
      'やめる場合は下の「キャンセル」を押してください。',
    ], '#1F6FEB', true))
    return { handled: true, replied }
  }

  // ここからは pending あり前提。
  if (!pending) return { handled: false, replied: false }

  // 月入力待ち。
  if (pending.step === 'await_month') {
    const m = text.replace(/[^\d]/g, '').match(/^(\d{4})(\d{2})$/)
    const mm = m ? Number(m[2]) : 0
    if (!m || mm < 1 || mm > 12) {
      const replied = await reply(budgetFlex('年月の形式が違います', [
        '西暦＋月を「6桁」で送ってください。',
        '例）2026年6月 → 202606',
        'やめる場合は下の「キャンセル」を押してください。',
      ], '#D14343', true))
      return { handled: true, replied }
    }
    const targetMonth = `${m[1]}-${m[2]}`
    const nowIso = new Date().toISOString()
    const expiresAt = new Date(Date.now() + PENDING_TTL_MIN * 60 * 1000).toISOString()
    await supabase.from(PENDING_TABLE).upsert({
      conversation_key: key,
      room_id: roomId,
      user_id: userId || null,
      store_partition_key: storeKey,
      step: 'await_amount',
      target_month: targetMonth,
      expires_at: expiresAt,
      updated_at: nowIso,
    }, { onConflict: 'conversation_key' })
    const replied = await reply(budgetFlex('予算額は？', [
      `対象：${Number(m[1])}年${Number(m[2])}月（${storeName}）`,
      '予算額（円）を数値で送ってください。',
      '例）1000000',
      'やめる場合は下の「キャンセル」を押してください。',
    ], '#1F6FEB', true))
    return { handled: true, replied }
  }

  // 金額入力待ち。
  if (pending.step === 'await_amount') {
    const targetMonth = String(pending.target_month ?? '')
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(targetMonth)) {
      await clearPending(supabase, key)
      const replied = await reply(budgetFlex('やり直してください', [
        '「予算登録」と送ってもう一度お願いします。',
      ], '#D14343'))
      return { handled: true, replied }
    }
    const cleaned = text.replace(/[,，\s¥￥円]/g, '')
    const amount = /^\d+$/.test(cleaned) ? Number(cleaned) : NaN
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_BUDGET_YEN) {
      const replied = await reply(budgetFlex('金額の形式が違います', [
        '予算額（円）を数値で送ってください。',
        '例）1000000',
        'やめる場合は下の「キャンセル」を押してください。',
      ], '#D14343', true))
      return { handled: true, replied }
    }

    // 既存の予算 / 過去売上があるか確認（あれば「上書き保存／キャンセル」の確認を挟む）。
    let existingBudget: number | null = null
    {
      const { data } = await supabase
        .from(BUDGET_TABLE)
        .select('budget_yen')
        .eq('store_partition_key', budgetStoreKey)
        .eq('target_month', targetMonth)
        .maybeSingle()
      if (data && (data as { budget_yen?: unknown }).budget_yen != null) {
        existingBudget = Number((data as { budget_yen?: unknown }).budget_yen)
      }
    }
    let salesCount = 0
    try {
      const yNum = Number(targetMonth.slice(0, 4))
      const mNum = Number(targetMonth.slice(5, 7))
      const nextStart = mNum >= 12 ? `${yNum + 1}-01-01` : `${yNum}-${String(mNum + 1).padStart(2, '0')}-01`
      const receiptTable = String(registry?.receipt_table ?? '').trim()
      if (receiptTable) {
        const { count } = await supabase
          .from(receiptTable)
          .select('id', { count: 'exact', head: true })
          .gte('receipt_date', `${targetMonth}-01`)
          .lt('receipt_date', nextStart)
        salesCount = Number(count ?? 0)
      }
    } catch (_e) {
      salesCount = 0
    }

    const [yy, mo] = targetMonth.split('-')
    if (existingBudget != null || salesCount > 0) {
      // 上書き確認を挟む（入力済みの金額を pending に保持）。
      const nowIso = new Date().toISOString()
      const expiresAt = new Date(Date.now() + PENDING_TTL_MIN * 60 * 1000).toISOString()
      await supabase.from(PENDING_TABLE).upsert({
        conversation_key: key,
        room_id: roomId,
        user_id: userId || null,
        store_partition_key: storeKey,
        step: 'await_overwrite_confirm',
        target_month: targetMonth,
        budget_yen: amount,
        expires_at: expiresAt,
        updated_at: nowIso,
      }, { onConflict: 'conversation_key' })
      const lines: string[] = [`対象：${Number(yy)}年${Number(mo)}月（${storeName}）`]
      if (existingBudget != null) lines.push(`・登録済みの予算：${formatYen(existingBudget)}`)
      if (salesCount > 0) lines.push(`・この月の売上データ：${salesCount}件あり`)
      lines.push(`・新しい予算：${formatYen(amount)}`)
      lines.push('この内容で上書き保存しますか？（やめる場合は「キャンセル」）')
      const replied = await reply(budgetConfirmFlex(
        `⚠️ ${Number(yy)}年${Number(mo)}月 は既にデータがあります`,
        lines,
      ))
      return { handled: true, replied }
    }

    // 既存なし → そのまま確定。
    const replied = await commitBudgetAndReply(
      supabase, key, budgetStoreKey, storeKey, storeName, targetMonth, amount, false, reply,
    )
    return { handled: true, replied }
  }

  // 上書き確認待ち。
  if (pending.step === 'await_overwrite_confirm') {
    const targetMonth = String(pending.target_month ?? '')
    const amount = Number(pending.budget_yen)
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(targetMonth) || !Number.isFinite(amount) || amount <= 0) {
      await clearPending(supabase, key)
      const replied = await reply(budgetFlex('やり直してください', [
        '「予算登録」と送ってもう一度お願いします。',
      ], '#D14343'))
      return { handled: true, replied }
    }
    if (OVERWRITE_WORDS.has(text)) {
      const replied = await commitBudgetAndReply(
        supabase, key, budgetStoreKey, storeKey, storeName, targetMonth, amount, true, reply,
      )
      return { handled: true, replied }
    }
    // 「キャンセル」は先頭の中止処理で拾う。それ以外（曖昧な入力）は再確認。
    const [yy, mo] = targetMonth.split('-')
    const replied = await reply(budgetConfirmFlex(
      `⚠️ ${Number(yy)}年${Number(mo)}月 は既にデータがあります`,
      [`新しい予算：${formatYen(amount)}`, '「上書き保存」か「キャンセル」を選んでください。'],
    ))
    return { handled: true, replied }
  }

  return { handled: false, replied: false }
}
