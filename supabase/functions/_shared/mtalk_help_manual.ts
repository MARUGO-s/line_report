/**
 * M-talk / Journal Report の使い方を、
 * 1対1トークのAIが横断参照するためのマニュアル入口。
 *
 * 正本:
 * - docs/CHAT-TALK-GUIDE.md
 * - docs/M-TALK-COMPLETE-GUIDE.md
 * - docs/JOURNAL-REPORT-FEATURES.md
 * - docs/JOURNAL-AI-CHAT-RULES.md
 *
 * Journal Report の統合知識本体:
 * - supabase/functions/_shared/line_report_help_manual.ts
 *
 * 利用者向け機能を変更した場合は、正本と対応するマニュアルデータを同時に更新する。
 * endpoint、鍵、顧客情報、メッセージ本文、実際の売上などは書かない。
 */
import {
  buildLineReportHelpIndex,
  isLineReportHelpQuestion,
  lineReportHelpSourcesForCode,
  selectLineReportHelpSections,
  wantsLineReportImplementationDetails,
} from './line_report_help_manual.ts'

export interface MtalkHelpSection {
  id: string
  title: string
  keywords: string[]
  content: string
}

export interface MtalkHelpSelection {
  section: MtalkHelpSection
  score: number
}

export const MTALK_HELP_OVERVIEW = [
  'M-talkは、社内メンバーが使うチャットです。',
  'テキスト、画像・ファイル、感情イラストの送信、1対1・複数人トーク、返信、リアクション、メンション、既読、検索、予約配信、予定確認、個人メモ、Keepメモ、アルバム、Web Push通知を利用できます。',
  '店舗Botがいるルームでは、レシート登録、#メモ、売上等の検索、電子ジャーナルに基づく質問も利用できます。',
].join('\n')

/** 仕組み・全体像を説明するセクションのID。どんな質問でも背景として常に添える。 */
export const MTALK_SYSTEM_OVERVIEW_SECTION_ID = 'system-overview'

export const MTALK_HELP_SECTIONS: MtalkHelpSection[] = [
  {
    id: MTALK_SYSTEM_OVERVIEW_SECTION_ID,
    title: 'M-talkの仕組み・全体像',
    keywords: [
      '仕組み', 'しくみ', '全体像', '構成', 'システム', 'とは', 'どういう', 'どんな', 'なぜ',
      '違い', 'ちがい', '概要', 'できること', '機能', 'ai', 'エーアイ', '人工知能', 'ボット',
      'bot', '安全', 'セキュリティ', 'プライバシー', 'データ', '保存', '対応', 'ブラウザ', 'アプリ', 'pwa',
    ],
    content: [
      'M-talkは、ブラウザで使う社内チャットです。ログイン中の本人の権限で動き、参加しているルームのメッセージだけを読み書きできます。',
      'ルームには「1対1」「複数人グループ」「店舗Botルーム」があります。店舗ルームには店舗Botが入り、レシート登録・#メモ・売上などの検索・電子ジャーナルAIといった業務機能が使えます。',
      'AIは2種類あります。(1)雑談・使い方AI：使い方の案内や簡単な相談に答えます。店舗の正確な売上・客数などの数字には答えません。(2)ジャーナルに聞く：電子ジャーナルの実データを根拠に、売上や客数などの正確な数字へ答える専用機能です。数字が必要なときは入力欄の「＋」→「ジャーナルに聞く」を使います。',
      '通知はWeb Push（ブラウザ通知）で届きます。iPhone・iPadは、ホーム画面に追加したアプリ版で開いたときだけ通知を受け取れます。',
      '画像やファイルは非公開の保管場所に保存され、表示のたびに一時的なURLで読み込みます。参加した時点より前のメッセージは、仕組み上あとから取得できません。',
      '権限は、M-talk全体の利用可否と、ルームごとの「閲覧・送信・招待・管理」の4種類で決まります。権限の変更はM-talk管理者が行います。',
      'この仕組みに書かれていないこと（他アプリの機能や、店舗の実データそのもの）は推測せず、正確な数字は「ジャーナルに聞く」へ案内してください。',
    ].join('\n'),
  },
  {
    id: 'start-login-profile',
    title: 'ログイン・新規登録・プロフィール',
    keywords: ['ログイン', '新規登録', '登録', 'アカウント', 'メール', 'パスワード', 'プロフィール', '表示名', '名前', 'アイコン', '初回'],
    content: [
      'メールアドレスとパスワードで新規登録します。初回だけ表示名とアイコンを決めると、M-talkを使い始められます。',
      '自分のアイコンは、画面左上の自分のアイコンを押し、「アイコンを変更」から変更できます。',
      '標準アイコンから選ぶか、自分の画像をアップロードできます。設定はサーバーに保存されるため、別端末でも同じプロフィールを使えます。',
    ].join('\n'),
  },
  {
    id: 'send-text',
    title: 'メッセージの送信と改行',
    keywords: ['送信', '送る', 'メッセージ', '入力', '改行', 'enter', 'エンター', 'shift', '書く', '文章'],
    content: [
      '入力欄に文章を入れて送信します。',
      'PCはEnterで送信、Shift+Enterで改行します。スマホは送信ボタンで送信し、Enterは改行になります。',
      '自分の発言は削除できますが、送信済みの内容は編集できません。訂正するときは削除して送り直します。',
    ].join('\n'),
  },
  {
    id: 'image-file',
    title: '画像・ファイルの送信',
    keywords: ['画像', '写真', 'ファイル', '添付', 'アップロード', 'pdf', 'word', 'excel', 'エクセル', 'powerpoint', 'csv', 'zip', 'ドラッグ', 'ドロップ', '貼り付け', 'ペースト'],
    content: [
      '入力欄左の「＋」を押し、「画像・ファイル」を選びます。',
      'PCでは、ファイルをトーク画面へドラッグ＆ドロップするか、コピーした画像を入力欄へ貼り付けても送れます。',
      '画像、PDF、Word、Excel、PowerPoint、テキスト、CSV、ZIPなどに対応し、1ファイル10MBまでです。',
      '添付後に「今すぐ送る」または「予約配信」を選べます。画像はタップで拡大し、文書ファイルはプレビューまたはダウンロードできます。',
    ].join('\n'),
  },
  {
    id: 'stickers',
    title: '感情イラスト（スタンプ）',
    keywords: ['スタンプ', '感情', 'イラスト', '顔マーク', '顔', '漫符', '記号', 'ステッカー'],
    content: [
      '入力欄の顔マーク「☺」から感情イラストを選びます。',
      '「感情」と「漫符・記号」のカテゴリを切り替えられます。',
      'イラストだけを「大きく送る」方法と、入力中の文章へ「文章内に入れる」方法があります。',
    ].join('\n'),
  },
  {
    id: 'reply-reaction-mention-read',
    title: '返信・リアクション・メンション・既読',
    keywords: ['返信', 'リプライ', '引用', 'リアクション', 'メンション', '宛先', '既読', '未読', '転送', 'コピー', '削除', '誰が'],
    content: [
      'メッセージの「…」メニューから、リアクション、返信、コピー、転送、自分の発言の削除ができます。',
      'リアクションは1人1種類です。別の絵文字を選ぶと置き換わり、同じ絵文字をもう一度押すと取り消せます。リアクションを押すと、誰が付けたか確認できます。',
      '入力中に「@」を入れると、そのルームの参加者をメンションできます。メンションされた人への通知には「@あなた宛」が付きます。',
      '自分の発言には既読が表示されます。複数人では「既読 N」、1対1では人数を付けず「既読」と表示されます。',
    ].join('\n'),
  },
  {
    id: 'search',
    title: 'トーク・メッセージの検索',
    keywords: ['検索', '探す', 'さがす', '見つける', '履歴', '過去', 'キーワード', 'トーク検索', 'メッセージ検索'],
    content: [
      'トーク一覧上部の「トークルームとメッセージ検索」に2文字以上入力すると、参加中のトークとメッセージを検索できます。',
      '検索結果を押すと、その発言の前後を読み込んで該当メッセージへ移動します。',
      'トーク画面右上の検索アイコンからは、投稿せずに「トーク履歴・メッセージ検索」「予定・予約カレンダー」「写真・メディアライブラリ」を開けます。',
      '写真・メディアライブラリは、店舗Botがいるルームだけで利用できます。',
    ].join('\n'),
  },
  {
    id: 'scheduled-send',
    title: '予約配信',
    keywords: ['予約配信', '予約送信', '時間指定', '日時指定', '後で送る', 'あとで送る', 'タイマー', '自動送信'],
    content: [
      '入力欄の「＋」を押し、「予約配信」を選んで送信日時を指定します。',
      'テキストだけでなく画像・ファイルも予約できます。',
      '予約内容は予約した本人だけが確認・取り消しできます。送信時に送信権限がなくなっていた場合は送信されません。',
    ].join('\n'),
  },
  {
    id: 'silent-send',
    title: '通知せず送る',
    keywords: ['通知せず', '通知なし', 'サイレント', '静かに送る', 'ミュート送信', '🔕'],
    content: [
      '入力欄の「＋」から「通知せず送る」を選ぶと、そのメッセージだけWeb Push通知を出さずに送れます。',
      '受信側には、そのメッセージへ「🔕」が表示されます。本文やトーク一覧の表示は通常のメッセージと同じです。',
    ].join('\n'),
  },
  {
    id: 'private-note',
    title: '個人メモ',
    keywords: ['個人メモ', '自分だけ', '自分用メモ', '送信しない', '送らないメモ', '目印', '付箋'],
    content: [
      '入力欄の「＋」から「個人メモ」を選ぶと、ルームへ送信せず、自分だけに見えるメモをタイムラインへ残せます。',
      '他の参加者、Bot、管理画面、Web Pushには表示されません。本人は別端末からも確認でき、削除できますが編集はできません。',
      '店舗ルームでJournal Reportへ資料登録する「#メモ」とは別の機能です。',
    ].join('\n'),
  },
  {
    id: 'keep',
    title: 'Keepメモ',
    keywords: ['keep', 'キープ', 'keepメモ', '保存', 'あとで見る', 'ブックマーク', '取っておく'],
    content: [
      '入力欄の「＋」から「Keepメモ」を開くと、自分だけが見られる保存場所へメモを残せます。',
      'Keepメモは特定のルームに限定されず、ルームをまたいで利用できます。',
      'メッセージの「…」メニューから、メッセージや画像をKeepへ保存することもできます。',
    ].join('\n'),
  },
  {
    id: 'album',
    title: 'ルームアルバム',
    keywords: ['アルバム', '写真整理', '画像整理', 'ギャラリー', '写真をまとめる'],
    content: [
      '入力欄の「＋」から「アルバム」を開き、アルバム名を付けて作成します。',
      '「画像を追加」から、現在のルームへ投稿済みの画像を選んでアルバムへ追加できます。',
      'アルバムはそのルームの参加者で共有して閲覧できます。',
    ].join('\n'),
  },
  {
    id: 'reservation-calendar',
    title: '予約表・予定カレンダー',
    keywords: ['予約確認', '予約表', '予約', '予定を見る', '予定', 'カレンダー', 'スケジュール', '来店', 'アレルギー', '誕生日'],
    content: [
      '入力欄の「＋」から「予定を見る」を選ぶか、右上の検索・メニューから「予定・予約カレンダー」を開きます。',
      '「予約」タブではGmail等から取り込まれた予約、「予定」タブではM-talkルームや同じ店舗のカレンダー予定を確認できます。',
      '閲覧権限があれば見ることができます。追加・編集・日付変更・キャンセルにはルーム管理権限が必要です。',
    ].join('\n'),
  },
  {
    id: 'notifications',
    title: 'Web Push通知',
    keywords: ['通知', 'プッシュ', 'push', 'ベル', '通知が来ない', '通知テスト', 'iphone', 'ipad', 'ホーム画面', 'バッジ'],
    content: [
      'ベルのアイコンから通知をONにします。',
      'iPhone・iPadでは、Safariの通常タブではなく、M-talkを「ホーム画面に追加」して開いたアプリ版だけが通知対象です。',
      '通知が切れた場合は、画面上部の「通知が切れたので、ここをタップして再開」を押します。',
      '通知が届くか確認するときは、ベルのメニューにある「通知テスト」を使います。',
    ].join('\n'),
  },
  {
    id: 'rooms-invite',
    title: '1対1・グループの作成と招待',
    keywords: ['1対1', 'トーク作成', 'ルーム作成', 'グループ作成', '新しいトーク', '招待', 'メンバー追加', '友だち', '招待リンク'],
    content: [
      'トーク一覧の「＋」から新しいトークを作成できます。作成できる範囲は、自分に設定されたM-talk全体権限によります。',
      '1対1トークは当事者2人で固定され、第三者を追加できません。',
      '複数人ルームでは、ヘッダーの招待アイコンから利用中のユーザーを追加したり、招待リンクを発行・共有したりできます。招待権限が必要です。',
    ].join('\n'),
  },
  {
    id: 'room-list-settings',
    title: 'ピン留め・ミュート・非表示・退出・ゴミ箱',
    keywords: ['ピン', 'ピン留め', 'ミュート', '非表示', '退出', '抜ける', 'ゴミ箱', '復元', '完全削除', 'ルーム設定'],
    content: [
      'トーク一覧のトークを、PCでは右クリック、スマホではスワイプやメニュー操作すると、ピン留め、ミュート、非表示、ルーム設定、退出などを選べます。',
      'ルーム管理権限があれば、店舗固定ルーム以外をゴミ箱へ移し、ゴミ箱タブから復元できます。',
      '完全削除は、管理権限を持つルーム作成者だけが実行でき、確認のためルーム名の再入力が必要です。',
    ].join('\n'),
  },
  {
    id: 'store-room',
    title: '店舗ルーム・#メモ・レシート',
    keywords: ['店舗ルーム', '店舗bot', 'ボット', 'bot', '#メモ', '#日報', '#note', '資料登録', 'レシート', '売上登録'],
    content: [
      '店舗の固定ルームへ「#メモ」「#日報」「#note」を付けて送ると、Journal Reportの資料へ登録され、店舗Botが結果を返します。',
      'レシート画像を送ると自動で売上登録され、結果カードから修正や削除ができます。これはその日1日分の登録です。',
      '過去の売上をまとめて登録するときはレシート画像ではなく、月次日別売上管理表（Excel／CSV）をこの店舗ルームへ送ります。ルームの店舗Botの店舗として取り込み、既存データがある期間は確認カードで置き換えを選びます。売上分析画面の「過去の日次売上を一括取込」へドラッグ＆ドロップしても同じことができます。',
      'ファイルに書かれた店舗がこのルームの店舗と違う場合は取り込まず、一致しないことを返信します。テンプレートには見本の店舗が入っているため、B3（店舗名）とC3（店舗キー）を自店舗へ直してから送ってください。',
      '#メモのない通常画像は、その投稿元ルームの写真・メディアライブラリへ保存されます。',
    ].join('\n'),
  },
  {
    id: 'journal-ai',
    title: 'ジャーナルに聞く',
    keywords: ['ジャーナルに聞く', '電子ジャーナル', 'ジャーナル', '正確な売上', '売上', '客数', '客単価', '集計', '数字', '実績', '分析'],
    content: [
      '売上、客数、客単価など、店舗の実データに基づく正確な数字を質問するときは、入力欄の「＋」から「ジャーナルに聞く」を開きます。',
      '「ジャーナルに聞く」は、対象店舗の電子ジャーナルを根拠に回答する専用機能です。利用できる部屋でだけボタンが表示されます。',
      '通常の雑談AIは店舗の実データを持たないため、正確な数字は入力欄の「＋」→「ジャーナルに聞く」を開いて確認してください。',
    ].join('\n'),
  },
  {
    id: 'permissions',
    title: '権限・閲覧専用・利用停止',
    keywords: ['権限', '閲覧専用', '閲覧のみ', '送れない', '見られない', '使えない', '利用停止', '制限', '管理者'],
    content: [
      'M-talkには全体の利用権限と、ルームごとの閲覧・送信・招待・管理権限があります。',
      '閲覧専用ルームでは「このルームは閲覧専用です。メッセージは送信できません」と表示されます。',
      'M-talk全体が停止または期限付き制限されている場合は、ログイン後の画面に理由と期限が表示されます。権限の変更はM-talk管理者が行います。',
    ].join('\n'),
  },
  {
    id: 'history',
    title: '履歴・参加前のメッセージ',
    keywords: ['履歴', '過去', '参加前', '前のメッセージ', '見えない', 'さかのぼる', '読み込み', '50件'],
    content: [
      '自分がそのルームへ参加した時点以降のメッセージだけを見ることができます。参加前の発言は仕様上取得できません。',
      '最初は最新50件が表示され、メッセージ欄の上端までスクロールすると50件ずつ過去を読み込みます。',
    ].join('\n'),
  },
  {
    id: 'troubleshooting',
    title: '困ったとき',
    keywords: ['困った', '不具合', 'エラー', 'できない', '動かない', '表示されない', 'ログインできない', '通知が来ない', '画像が見えない'],
    content: [
      'ログインできない場合はメールアドレスとパスワードを確認し、M-talkの利用が停止されていないか管理者へ確認します。',
      '送信できない、ルームが見えない場合は、そのルームの閲覧・送信権限を確認します。',
      '通知が来ない場合は、再開バー、通知設定、通知テストを確認します。iPhone・iPadはホーム画面版で開いているかも確認します。',
      '画像が表示されない場合は表示用URLの期限切れの可能性があるため、画面を再読み込みします。',
    ].join('\n'),
  },
]

function normalize(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[！!。、，,.・:：;；「」『』（）()［\][\]【】]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function scoreSection(section: MtalkHelpSection, normalizedQuestion: string): number {
  let score = 0
  for (const keyword of section.keywords) {
    const normalizedKeyword = normalize(keyword)
    if (!normalizedKeyword || !normalizedQuestion.includes(normalizedKeyword)) continue
    score += normalizedKeyword.length >= 4 ? 4 : normalizedKeyword.length >= 2 ? 3 : 1
  }
  const normalizedTitle = normalize(section.title)
  if (normalizedTitle && normalizedQuestion.includes(normalizedTitle)) score += 5
  return score
}

/** 質問に関連するマニュアル項目だけを、関連度順に返す。 */
export function selectMtalkHelpSections(question: string, limit = 3): MtalkHelpSelection[] {
  const normalizedQuestion = normalize(question)
  if (!normalizedQuestion) return []
  return MTALK_HELP_SECTIONS
    .map((section) => ({ section, score: scoreSection(section, normalizedQuestion) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.section.id.localeCompare(b.section.id))
    .slice(0, Math.max(0, limit))
}

/** M-talkの操作・機能について尋ねている可能性が高いかを判定する。 */
export function isMtalkHelpQuestion(question: string): boolean {
  const normalizedQuestion = normalize(question)
  if (!normalizedQuestion) return false
  const helpIntents = [
    '使い方',
    'つかいかた',
    'やり方',
    'やりかた',
    'どうやって',
    'どうすれば',
    'どこから',
    '方法',
    '教えて',
    'おしえて',
    'できますか',
    'できる？',
    'できる?',
    'どこ',
    '見方',
    '開き方',
    '送り方',
    '設定',
    '変更',
    'ヘルプ',
    'help',
    '来ない',
    'できない',
    '見えない',
    '送れない',
    '仕組み',
    'しくみ',
    '全体像',
    'とは',
    'どういう',
    'なぜ',
    'なんで',
    '違い',
    'ちがい',
    '安全',
    'セキュリティ',
    'プライバシー',
    '対応',
    'なんですか',
    'なんですが',
  ]
  return isLineReportHelpQuestion(question) ||
    helpIntents.some((intent) => normalizedQuestion.includes(intent)) ||
    selectMtalkHelpSections(question, 1).some((entry) => entry.score >= 4)
}

/**
 * AIへ渡すマニュアル抜粋を作る。
 * 一般的な「何ができる？」には概要と主要機能を、具体的な質問には関連項目だけを渡す。
 */
export function buildMtalkHelpReference(
  question: string,
  options: {
    limit?: number
    lineReportLimit?: number
    maxChars?: number
  } = {},
): string {
  if (!isMtalkHelpQuestion(question)) return ''
  const mtalkLimit = Math.max(1, options.limit ?? 3)
  const lineReportLimit = Math.max(1, options.lineReportLimit ?? 4)
  const maxChars = Math.max(800, options.maxChars ?? 6800)
  const selections = selectMtalkHelpSections(question, mtalkLimit)
  const lineReportSelections = selectLineReportHelpSections(question, lineReportLimit)
  const includeImplementationSources = wantsLineReportImplementationDetails(question)
  const selectedIds = new Set(selections.map((entry) => entry.section.id))
  const parts = [
    '【回答の基本】\n質問された範囲だけを、最初に結論、その後に必要な手順・理由・注意点の順で簡潔に答える。索引全体を回答へ書き写さない。質問が曖昧なら、推測せず確認を1つだけ行う。',
    `【M-talk全体概要】\n${MTALK_HELP_OVERVIEW}`,
  ]

  // 仕組み・全体像は「なぜ」「どういう仕組み」などにも答えられるよう常に添える。
  const overviewSection = MTALK_HELP_SECTIONS.find(
    (section) => section.id === MTALK_SYSTEM_OVERVIEW_SECTION_ID,
  )
  if (overviewSection && !selectedIds.has(overviewSection.id)) {
    parts.push(`【${overviewSection.title}】\n${overviewSection.content}`)
  }

  // 質問に関連する詳細セクション（関連度順）。
  for (const { section } of selections) {
    parts.push(`【${section.title}】\n${section.content}`)
  }

  // M-talk / Journal Report はカテゴリ索引＋質問に近い詳細だけを渡す。
  // 全資料を毎回渡さないことで、回答を短く保ちながら必要な根拠を深くする。
  parts.push(`【M-talk / Journal Report 区分索引】\n${buildLineReportHelpIndex()}`)
  for (const { section } of lineReportSelections) {
    const sources = includeImplementationSources
      ? lineReportHelpSourcesForCode(section.code)
      : []
    parts.push(
      `【${section.code} ${section.title}】\n要点: ${section.summary}\n${section.content}` +
        (sources.length ? `\n実装根拠: ${sources.join(' / ')}` : ''),
    )
  }

  // M-talk側も索引しやすいよう、詳細本文ではなくタイトルだけの短い索引を添える。
  const mtalkIndex = MTALK_HELP_SECTIONS
    .filter((section) => section.id !== MTALK_SYSTEM_OVERVIEW_SECTION_ID)
    .map((section) => section.title)
    .join(' / ')
  parts.push(`【M-talk機能索引】\n${mtalkIndex}`)

  const reference = parts.join('\n\n')
  return reference.length <= maxChars ? reference : `${reference.slice(0, maxChars)}…`
}
