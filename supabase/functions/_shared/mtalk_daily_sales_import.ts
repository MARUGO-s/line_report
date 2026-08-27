/**
 * M-talk 店舗ルームへ送られた月次日別売上管理表（Excel／CSV）を、
 * そのルームの店舗Botに紐づく店舗として取り込む。
 *
 * LINE版（line-webhook の processDailySalesFileEvent）と同じ解析・登録処理を
 * 使うが、投入先の決め方が違う:
 *   LINE  … Webhook の store_partition_key（ルーム＝店舗）
 *   M-talk… ルームにいる店舗Botの店舗キー
 *
 * 店舗が一致しない場合は取り込まず、一致しない事実だけを返信する。
 * テンプレートには見本店舗の店舗キー(C3)が入ったまま配布されるため、
 * 直し忘れたファイルで他店の売上を書き換える事故を防ぐことを優先する。
 */
import {
  countExistingReceiptsForDates,
  importDailyReceiptsOverwrite,
  importManualMonthSalesOverwrite,
  parseMonthlyDailySalesWorkbook,
  resolveReceiptTableForStore,
  type DailySalesParseResult,
} from './daily_sales_import.ts'
import { fetchManualMonthSales } from './manual_month_sales.ts'
import { resolveReceiptNamePartitionKey } from './receipt_store_name_resolve.ts'
import { postChatCard, type ChatCardFieldRow } from './chat_bridge.ts'
import { postStoreRoomLineStyleReply } from './chat_store_file_bridge.ts'

// deno-lint-ignore no-explicit-any
type DbClient = any

type BotUser = { id: string; username: string } | null

/** 確認待ちを指すコマンド。カードのボタンから本文として送られる。 */
const CONFIRM_COMMAND_PREFIX = '売上取込'
const CONFIRM_APPLY = '置き換えて登録'
const CONFIRM_CANCEL = '中止'

// line-webhook の DAILY_SALES_TEMPLATE_KEY / maybeServeTemplateDownload と一致させること。
// 配布本体は public.line_file_templates にあり、line-webhook がGETで返す（M-talk専用の配布経路は無い）。
const DAILY_SALES_TEMPLATE_KEY = 'daily_sales_management_xlsx'

export function isDailySalesWorkbookName(fileName: string): boolean {
  return /\.(xlsx|xls|csv)$/i.test(String(fileName ?? '').trim())
}

/**
 * 「日別売上管理表」「売上管理表テンプレート」等、テンプレートを求める発言か。
 * line-webhook の isDailySalesTemplateRequestText と同じ判定にしておく
 * （LINEでもM-talkでも同じ言葉で反応させるため）。
 */
export function isDailySalesTemplateRequestText(text: string): boolean {
  const compact = String(text ?? '').replace(/\s+/g, '').toLowerCase()
  if (!compact) return false
  const exact = new Set([
    '日別売上管理表',
    '月次日別売上管理表',
    '売上管理表',
    '売上管理表テンプレート',
    '日別売上テンプレート',
    '過去売上テンプレート',
    'excelテンプレート',
    'エクセルテンプレート',
  ])
  if (exact.has(compact)) return true
  const asksTemplate = compact.includes('テンプレ') || compact.includes('ひな形') || compact.includes('雛形') ||
    compact.includes('フォーマット') || compact.includes('ダウンロード')
  const asksSalesSheet = compact.includes('売上') || compact.includes('日別') || compact.includes('excel') ||
    compact.includes('エクセル')
  return asksTemplate && asksSalesSheet
}

/**
 * テンプレート配布URL。実体はline-webhookのGET(?download=)が返す。
 * M-talk用の配布経路を別に持たず、既存のLINE配布をそのまま指す
 * （storeKeyはパスに載せるだけで配布内容そのものは店舗共通）。
 */
function dailySalesTemplateUrl(storeKey: string): string {
  const supabaseUrl = String(Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '')
  const base = supabaseUrl
    ? `${supabaseUrl}/functions/v1/line-webhook`
    : 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/line-webhook'
  return `${base}/${encodeURIComponent(storeKey)}?download=${encodeURIComponent(DAILY_SALES_TEMPLATE_KEY)}`
}

/** テンプレート要求に対して、ダウンロードリンク付きのカードを返す。 */
export async function replyDailySalesTemplateDownload(
  supabase: DbClient,
  params: { groupId: number; storeKey: string; asUser: BotUser },
): Promise<void> {
  const url = dailySalesTemplateUrl(params.storeKey)
  await postChatCard(supabase, {
    groupId: params.groupId,
    kind: 'daily_sales_template',
    text: [
      '📄 日別売上管理表テンプレート',
      '過去売上をまとめて登録するための基本Excelです。ダウンロードして金額を入力し、このルームへ送り返してください。',
      '月合計だけ登録する場合は、B37「合計だけ入力」に総売上を入れてください。',
      `ダウンロード: ${url}`,
    ].join('\n'),
    cards: [{
      variant: 'line',
      header: { title: '日別売上管理表テンプレート' },
      sections: [
        { type: 'note', text: '過去売上をまとめて登録するための基本Excelです。ダウンロードして金額を入力し、このルームへ送り返してください。' },
        { type: 'note', text: '月合計だけ登録する場合は、B37「合計だけ入力」に総売上を入れてください。', size: 'xs' },
      ],
      action: { label: 'Excelをダウンロード', url, style: 'primary' },
    }],
    asUser: params.asUser,
  })
}

/**
 * 解析に失敗しても「日別売上管理表らしさ」があるか。
 * 店舗名・店舗キー・対象期間のどれかが読めていれば、様式は合っているが
 * 金額が未入力とみなして案内を返す（無反応にしない）。
 *
 * 解析エラーの有無は見ない。エラーはただのCSVでも必ず立つため、これを
 * 根拠にすると店舗ルームへ置いた無関係な表にまでBotが反応してしまう。
 */
function looksLikeDailySalesTemplate(parsed: DailySalesParseResult): boolean {
  return !!(parsed.period || parsed.store_name || parsed.store_key)
}

function yen(n: number): string {
  return '¥' + Number(n || 0).toLocaleString('ja-JP')
}

function periodLabel(parsed: DailySalesParseResult): string {
  if (parsed.period) return parsed.period
  const ds = parsed.entries.map((e) => e.sales_date).sort()
  return ds.length ? `${ds[0]}〜${ds[ds.length - 1]}` : ''
}

/** ファイルが指している店舗キー。C3を最優先し、無ければ店名ゆらぎ照合。 */
function resolveFileStoreKey(parsed: DailySalesParseResult): string | null {
  const direct = String(parsed.store_key ?? '').trim()
  if (direct) return direct.toLowerCase()
  const byName = parsed.store_name ? resolveReceiptNamePartitionKey(parsed.store_name) : null
  return byName ? String(byName).toLowerCase() : null
}

function summaryRows(parsed: DailySalesParseResult, storeDisplay: string): ChatCardFieldRow[] {
  const manual = parsed.import_mode === 'manual_month' ? parsed.manual_month_entry ?? null : null
  const rows: ChatCardFieldRow[] = [
    { label: '投入先店舗', value: storeDisplay },
    { label: '期間', value: periodLabel(parsed) },
    { label: '取込形式', value: manual ? '月合計（合計だけ入力）' : '日別売上' },
    { label: '対象日数', value: manual ? '日別なし' : `${parsed.day_count}日` },
    { label: '合計総売上', value: yen(parsed.total_gross_yen) },
  ]
  return rows.filter((row) => row.value && String(row.value).trim())
}

/**
 * 店舗が一致しないファイルへの返信。取り込みは行わない。
 * どこを直せばよいか分かるよう、ファイル側の記載とルーム側の店舗を並べる。
 */
async function replyStoreMismatch(
  supabase: DbClient,
  params: {
    groupId: number
    fileName: string
    storeDisplay: string
    roomStoreKey: string
    parsed: DailySalesParseResult
    asUser: BotUser
  },
): Promise<void> {
  const fileKey = String(params.parsed.store_key ?? '').trim()
  const fileName = String(params.parsed.store_name ?? '').trim()
  const rows: ChatCardFieldRow[] = [
    {
      label: 'ファイルの店舗',
      value: [fileName || '（店舗名の記載なし）', fileKey ? `（${fileKey}）` : ''].join(''),
      color: '#c0392b',
    },
    { label: 'このルームの店舗', value: `${params.storeDisplay}（${params.roomStoreKey}）` },
    { label: '期間', value: periodLabel(params.parsed) },
  ]
  await postChatCard(supabase, {
    groupId: params.groupId,
    kind: 'daily_sales_store_mismatch',
    text: [
      '⚠️ このルームの店舗と、ファイルに書かれた店舗が一致しないため取り込みませんでした。',
      `ファイルの店舗: ${fileName || '（記載なし）'}${fileKey ? `（${fileKey}）` : ''}`,
      `このルームの店舗: ${params.storeDisplay}（${params.roomStoreKey}）`,
      'ファイルのB3（店舗名）とC3（店舗キー）をこのルームの店舗へ直してから、もう一度送ってください。',
    ].join('\n'),
    cards: [{
      variant: 'line',
      header: { title: '⚠️ 店舗が一致しません', subtitle: params.fileName },
      sections: [
        { type: 'note', text: 'ファイルに書かれた店舗が、このルームの店舗と違うため取り込みを中止しました。', color: '#c0392b' },
        { type: 'fields', rows },
        {
          type: 'note',
          text: 'テンプレートには見本の店舗が入っています。B3（店舗名）とC3（店舗キー）をこのルームの店舗へ直してから、もう一度送ってください。',
          size: 'xs',
        },
      ],
    }],
    asUser: params.asUser,
  })
}

/**
 * M-talk 店舗ルームのExcel／CSVを取り込む。
 * 戻り値 handled=false のときは日次売上ファイルではないので、呼び出し側は
 * 通常のファイル添付として処理を続ける。
 */
export async function processMtalkDailySalesFile(
  supabase: DbClient,
  params: {
    groupId: number
    storeKey: string
    path: string
    fileName: string
    asUser: BotUser
  },
): Promise<{ handled: boolean; reason: string }> {
  if (!isDailySalesWorkbookName(params.fileName)) return { handled: false, reason: 'not_workbook' }

  const { data: file, error: downloadError } = await supabase.storage
    .from('chat-images')
    .download(params.path)
  if (downloadError || !file) {
    console.warn('mtalk daily sales download failed:', downloadError?.message)
    return { handled: false, reason: 'download_failed' }
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const parsed = parseMonthlyDailySalesWorkbook(bytes, params.fileName)

  const roomStoreKey = String(params.storeKey ?? '').trim().toLowerCase()
  const resolved = await resolveReceiptTableForStore(supabase, roomStoreKey)
  const storeDisplay = resolved?.storeDisplay ?? roomStoreKey
  const receiptTable = resolved?.receiptTable ?? `line_receipt__${roomStoreKey}`

  // 売上管理表ではないただのExcel／CSV。添付として残すだけにする。
  if (!parsed.recognized && !looksLikeDailySalesTemplate(parsed)) {
    return { handled: false, reason: 'not_daily_sales_file' }
  }

  // 店舗の判定は金額の有無より先に行う。他店のファイルへ「金額を入れてください」と
  // 案内すると、直すべき箇所（店舗欄）から目をそらせてしまうため。
  const fileStoreKey = resolveFileStoreKey(parsed)
  if (!fileStoreKey || fileStoreKey !== roomStoreKey) {
    await replyStoreMismatch(supabase, {
      groupId: params.groupId,
      fileName: params.fileName,
      storeDisplay,
      roomStoreKey,
      parsed,
      asUser: params.asUser,
    })
    return { handled: true, reason: 'store_mismatch' }
  }

  if (!parsed.recognized) {
    await postStoreRoomLineStyleReply(supabase, params.groupId, {
      text: [
        '日別売上管理表として読み取りましたが、登録対象の売上がありません。',
        parsed.error ? `理由: ${parsed.error}` : '',
        '月合計だけ登録する場合は、B37「合計だけ入力」の総売上欄に金額を入れてください。',
        '日別で登録する場合は、各日の「総売上(税込)」欄に金額を入れてください。',
      ].filter(Boolean).join('\n'),
    }, params.asUser)
    return { handled: true, reason: 'daily_sales_empty' }
  }

  const coveredDates = (parsed.covered_dates && parsed.covered_dates.length)
    ? parsed.covered_dates
    : parsed.entries.map((e) => e.sales_date)
  const existingCount = await countExistingReceiptsForDates(supabase, receiptTable, coveredDates)
  const existingManualMonth = parsed.import_mode === 'manual_month' && parsed.manual_month_entry
    ? await fetchManualMonthSales(supabase, roomStoreKey, parsed.manual_month_entry.sales_month)
    : null

  // 既存データがある期間は、置き換えの確認を取ってから登録する。
  if (existingCount > 0 || existingManualMonth) {
    const pendingId = await insertPendingImport(supabase, {
      groupId: params.groupId,
      roomStoreKey,
      fileName: params.fileName,
      parsed,
      coveredDates,
      existingCount,
    })
    if (!pendingId) {
      await postStoreRoomLineStyleReply(supabase, params.groupId, {
        text: '取込の確認を準備できませんでした。少し時間をおいて、もう一度ファイルを送ってください。',
      }, params.asUser)
      return { handled: true, reason: 'pending_insert_failed' }
    }
    const isManualMonth = parsed.import_mode === 'manual_month'
    const warn = isManualMonth
      ? `対象月には既に月合計売上が登録されています。「${CONFIRM_APPLY}」で既存の月合計を上書きします。`
      : `取込対象期間には既に ${existingCount}件 のデータがあります。「${CONFIRM_APPLY}」で期間を丸ごと置換します（0=休業の日は売上なしにクリア／以前のデータは残りません）。`
    await postChatCard(supabase, {
      groupId: params.groupId,
      kind: 'daily_sales_confirm',
      text: [
        isManualMonth ? '月合計売上を登録しますか？' : '日次売上を登録しますか？',
        `投入先店舗: ${storeDisplay}`,
        `期間: ${periodLabel(parsed)} / 合計総売上 ${yen(parsed.total_gross_yen)}`,
        `⚠️ ${warn}`,
        `登録する場合は「${CONFIRM_COMMAND_PREFIX} ${CONFIRM_APPLY} ${pendingId}」と送ってください。`,
      ].join('\n'),
      cards: [{
        variant: 'line',
        header: { title: isManualMonth ? '月合計売上を登録しますか？' : '日次売上を登録しますか？', subtitle: params.fileName },
        sections: [
          { type: 'fields', rows: summaryRows(parsed, storeDisplay) },
          { type: 'note', text: `⚠️ ${warn}`, color: '#c0392b' },
        ],
        actions: [
          { label: CONFIRM_APPLY, command: `${CONFIRM_COMMAND_PREFIX} ${CONFIRM_APPLY} ${pendingId}`, style: 'primary' },
          { label: CONFIRM_CANCEL, command: `${CONFIRM_COMMAND_PREFIX} ${CONFIRM_CANCEL} ${pendingId}`, style: 'secondary' },
        ],
      }],
      asUser: params.asUser,
    })
    return { handled: true, reason: 'daily_sales_confirm' }
  }

  return await applyImport(supabase, {
    groupId: params.groupId,
    roomStoreKey,
    storeDisplay,
    parsed,
    coveredDates,
    fileName: params.fileName,
    asUser: params.asUser,
  })
}

async function insertPendingImport(
  supabase: DbClient,
  params: {
    groupId: number
    roomStoreKey: string
    fileName: string
    parsed: DailySalesParseResult
    coveredDates: string[]
    existingCount: number
  },
): Promise<number | null> {
  const { data, error } = await supabase
    .from('pending_daily_sales_imports')
    .insert({
      room_id: `mtalk-group-${params.groupId}`,
      store_partition_key: params.roomStoreKey,
      file_store_name: params.parsed.store_name,
      file_name: params.fileName,
      line_message_id: `mtalk-${params.groupId}-${Date.now()}`,
      period: params.parsed.period,
      import_mode: params.parsed.import_mode,
      manual_month_entry: params.parsed.manual_month_entry,
      entries: params.parsed.entries,
      covered_dates: params.coveredDates,
      day_count: params.parsed.day_count,
      total_gross_yen: params.parsed.total_gross_yen,
      existing_count: params.existingCount,
      store_matched: true,
      status: 'pending',
    })
    .select('id')
    .single()
  if (error) {
    console.error('mtalk pending_daily_sales_imports insert failed:', error.message)
    return null
  }
  return Number((data as { id?: number } | null)?.id ?? 0) || null
}

async function applyImport(
  supabase: DbClient,
  params: {
    groupId: number
    roomStoreKey: string
    storeDisplay: string
    parsed: DailySalesParseResult
    coveredDates: string[]
    fileName: string
    asUser: BotUser
  },
): Promise<{ handled: boolean; reason: string }> {
  const isManualMonth = params.parsed.import_mode === 'manual_month'
  try {
    const res = isManualMonth && params.parsed.manual_month_entry
      ? await importManualMonthSalesOverwrite(
        supabase,
        params.roomStoreKey,
        params.parsed.manual_month_entry,
        params.coveredDates,
      )
      : await importDailyReceiptsOverwrite(
        supabase,
        params.roomStoreKey,
        params.parsed.entries,
        params.coveredDates,
      )
    await postChatCard(supabase, {
      groupId: params.groupId,
      kind: 'daily_sales_imported',
      text: [
        isManualMonth ? '✅ 月合計売上を登録しました' : '✅ 日次売上を登録しました',
        `投入先店舗: ${params.storeDisplay}`,
        `期間: ${periodLabel(params.parsed)} / 合計総売上 ${yen(params.parsed.total_gross_yen)}`,
        isManualMonth
          ? '日別データは作らず、月合計の手入力売上として登録しました（売上分析・前年比に反映）。'
          : `${res.applied}日分をレシートとして登録（売上分析・前年比に反映）。`,
      ].join('\n'),
      cards: [{
        variant: 'line',
        header: { title: isManualMonth ? '✅ 月合計売上を登録しました' : '✅ 日次売上を登録しました', subtitle: params.fileName },
        sections: [
          { type: 'fields', rows: summaryRows(params.parsed, params.storeDisplay) },
          {
            type: 'note',
            text: isManualMonth
              ? '日別データは作らず、月合計の手入力売上として登録しました（売上分析・前年比に反映）。'
              : `${res.applied}日分をレシートとして登録（売上分析・前年比に反映）。`,
            size: 'xs',
          },
        ],
      }],
      asUser: params.asUser,
    })
    return { handled: true, reason: isManualMonth ? 'manual_month_imported' : 'daily_sales_imported' }
  } catch (e) {
    const msg = (e as { message?: string })?.message || String(e)
    await postStoreRoomLineStyleReply(supabase, params.groupId, {
      text: `日次売上の登録に失敗しました: ${msg}`.slice(0, 300),
    }, params.asUser)
    return { handled: true, reason: 'daily_sales_import_failed' }
  }
}

/**
 * 確認カードのボタンから送られる「売上取込 置き換えて登録 <id>」を処理する。
 * 対象外の本文なら handled=false を返し、呼び出し側は通常処理を続ける。
 */
export async function handleMtalkDailySalesCommand(
  supabase: DbClient,
  params: {
    groupId: number
    storeKey: string
    text: string
    asUser: BotUser
  },
): Promise<{ handled: boolean; reason: string }> {
  const text = String(params.text ?? '').trim()
  if (!text.startsWith(CONFIRM_COMMAND_PREFIX)) return { handled: false, reason: 'not_command' }
  const rest = text.slice(CONFIRM_COMMAND_PREFIX.length).trim()
  const cancel = rest.startsWith(CONFIRM_CANCEL)
  const apply = rest.startsWith(CONFIRM_APPLY)
  if (!cancel && !apply) return { handled: false, reason: 'not_command' }
  const pendingId = Number(rest.replace(/[^0-9]/g, ''))
  if (!Number.isInteger(pendingId) || pendingId <= 0) return { handled: false, reason: 'not_command' }

  const { data: pending, error } = await supabase
    .from('pending_daily_sales_imports')
    .select('id, store_partition_key, file_name, period, import_mode, manual_month_entry, entries, covered_dates, day_count, total_gross_yen, status')
    .eq('id', pendingId)
    .maybeSingle()
  if (error || !pending) {
    await postStoreRoomLineStyleReply(supabase, params.groupId, {
      text: 'この取込はすでに終了しているか、見つかりませんでした。もう一度ファイルを送ってください。',
    }, params.asUser)
    return { handled: true, reason: 'pending_missing' }
  }
  const row = pending as Record<string, unknown>
  if (String(row.status ?? '') !== 'pending') {
    await postStoreRoomLineStyleReply(supabase, params.groupId, {
      text: 'この取込はすでに処理済みです。',
    }, params.asUser)
    return { handled: true, reason: 'pending_done' }
  }
  // 確認カードを出した店舗とコマンドを送ったルームの店舗が違う場合は実行しない。
  const roomStoreKey = String(params.storeKey ?? '').trim().toLowerCase()
  if (String(row.store_partition_key ?? '').trim().toLowerCase() !== roomStoreKey) {
    await postStoreRoomLineStyleReply(supabase, params.groupId, {
      text: 'この取込は別の店舗のものです。このルームでは実行できません。',
    }, params.asUser)
    return { handled: true, reason: 'store_mismatch' }
  }

  if (cancel) {
    await supabase
      .from('pending_daily_sales_imports')
      .update({ status: 'dismissed', updated_at: new Date().toISOString() })
      .eq('id', pendingId)
    await postStoreRoomLineStyleReply(supabase, params.groupId, {
      text: '取込を中止しました。既存のデータはそのままです。',
    }, params.asUser)
    return { handled: true, reason: 'daily_sales_dismissed' }
  }

  const resolved = await resolveReceiptTableForStore(supabase, roomStoreKey)
  const storeDisplay = resolved?.storeDisplay ?? roomStoreKey
  const parsed = {
    recognized: true,
    import_mode: String(row.import_mode ?? 'daily'),
    store_name: null,
    store_key: null,
    period: (row.period as string | null) ?? null,
    manual_month_entry: (row.manual_month_entry ?? null) as DailySalesParseResult['manual_month_entry'],
    entries: (row.entries ?? []) as DailySalesParseResult['entries'],
    covered_dates: (row.covered_dates ?? []) as string[],
    day_count: Number(row.day_count ?? 0),
    total_gross_yen: Number(row.total_gross_yen ?? 0),
    skipped_zero_count: 0,
    warnings: [],
    error: '',
  } as DailySalesParseResult

  const result = await applyImport(supabase, {
    groupId: params.groupId,
    roomStoreKey,
    storeDisplay,
    parsed,
    coveredDates: parsed.covered_dates,
    fileName: String(row.file_name ?? ''),
    asUser: params.asUser,
  })
  await supabase
    .from('pending_daily_sales_imports')
    .update({
      status: result.reason === 'daily_sales_import_failed' ? 'pending' : 'imported',
      updated_at: new Date().toISOString(),
    })
    .eq('id', pendingId)
  return result
}
