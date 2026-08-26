/**
 * LINE Report / Journal Report の1対1 AI向け統合知識。
 *
 * 目的:
 * - M-talk内のAIが、M-talkだけでなくLINE ReportとJournal Reportの
 *   機能・操作・仕組み・違い・注意点を正確に案内できるようにする。
 * - 回答時は全資料をそのまま並べず、区分索引から関連項目だけを選んで
 *   「正確に詳しいが、回答は短く分かりやすい」状態を作る。
 *
 * 正本:
 * - docs/操作マニュアル.md
 * - docs/JOURNAL-REPORT-FEATURES.md
 * - docs/JOURNAL-AI-CHAT-RULES.md
 * - docs/JOURNAL-STORE-KNOWLEDGE.md
 * - docs/CHAT-TALK-GUIDE.md
 * - docs/M-TALK-COMPLETE-GUIDE.md
 * - docs/SECURITY.md
 *
 * 禁止:
 * - シークレット、内部トークン、顧客の実データをここへ書かない。
 * - 店舗の実売上など、質問時点の業務データをマニュアル知識で推測しない。
 */

export interface LineReportHelpCategory {
  id: string
  code: string
  title: string
  description: string
  keywords: string[]
}

export interface LineReportHelpSection {
  id: string
  code: string
  categoryId: string
  title: string
  keywords: string[]
  summary: string
  content: string
}

export interface LineReportHelpSelection {
  section: LineReportHelpSection
  score: number
}

export const LINE_REPORT_HELP_CATEGORIES: LineReportHelpCategory[] = [
  {
    id: 'ecosystem',
    code: 'SYS',
    title: '全体像・画面・ログイン',
    description: 'LINE Report、M-talk、Journal Report、管理画面の役割と入口',
    keywords: ['全体像', '仕組み', 'line report', '画面', 'ログイン', 'アプリ', '違い'],
  },
  {
    id: 'sales',
    code: 'SAL',
    title: '売上・レシート・予算',
    description: 'LINEレシート、売上照会、予算、Excel、売上分析と定期レポート',
    keywords: ['売上', 'レシート', '予算', 'excel', '分析', '月次', '日次'],
  },
  {
    id: 'reservations',
    code: 'RSV',
    title: '予約・カレンダー',
    description: 'Gmail自動取込、予約スクショ、予約表、本日の予約',
    keywords: ['予約', 'gmail', '食べログ', '一休', 'スクショ', 'カレンダー'],
  },
  {
    id: 'operations',
    code: 'OPS',
    title: '店舗運用・権限・小口',
    description: 'ルーム設定、配信、検索、メディア、小口現金とトラブル対応',
    keywords: ['設定', '権限', 'ルーム', '配信', '検索', 'メディア', '小口', '経費'],
  },
  {
    id: 'journal-core',
    code: 'JRN',
    title: 'Journal Report基本・取込',
    description: '電子ジャーナル取込、保存レポート、店舗情報と確定集計',
    keywords: ['journal report', 'ジャーナルレポート', '電子ジャーナル', 'lzh', 'jnl', '取込', '保存レポート'],
  },
  {
    id: 'journal-knowledge',
    code: 'KNW',
    title: '資料・#メモ・店舗情報',
    description: '資料タブ、LINE #メモ、施策・メニュー・営業カレンダー',
    keywords: ['資料', '#メモ', '#日報', '#note', '施策', 'メニュー', '店舗情報'],
  },
  {
    id: 'journal-ai',
    code: 'JAI',
    title: 'Journal AI分析・チャット',
    description: '確定集計、商品・コード・コース、比較、予約、予測、PDF',
    keywords: ['ai分析', 'aiチャット', '商品コード', 'コース', '比較', '予測', 'pdf'],
  },
  {
    id: 'foodcourt',
    code: 'FCT',
    title: 'フードコート分析・日報・予測',
    description: 'テナント実績、イベント・天気、日報、複数AI、来客予測と進化',
    keywords: ['フードコート', 'marugo s', 'テナント', '日報', '来客予測', '週次', '進化'],
  },
  {
    id: 'reviews',
    code: 'REV',
    title: '口コミ・競合分析',
    description: '自店舗Google口コミ、周辺競合、評価・件数・競合圧力',
    keywords: ['口コミ', 'レビュー', 'google', '競合', 'place id', '評価'],
  },
  {
    id: 'administration',
    code: 'ADM',
    title: '管理・利用状況・システム情報',
    description: '管理画面、承認、Webhook、ログ、AI使用量、システムマップ',
    keywords: ['管理画面', '承認', 'webhook', 'ログ', 'ai使用料', 'システムマップ'],
  },
  {
    id: 'safety',
    code: 'SEC',
    title: '正確性・安全・制限',
    description: '数値の正本、店舗スコープ、非公開保存、回答できる範囲',
    keywords: ['正確', '安全', 'セキュリティ', 'プライバシー', '制限', 'できない', '根拠'],
  },
]

export const LINE_REPORT_HELP_SECTIONS: LineReportHelpSection[] = [
  {
    id: 'ecosystem-overview',
    code: 'SYS-01',
    categoryId: 'ecosystem',
    title: 'LINE Report全体の役割分担',
    keywords: [
      'line report', 'lineレポート', '全体', '全体像', '仕組み', '構成', '何ができる',
      'm-talk', 'mtalk', 'ジャーナルレポート', 'journal report', '管理画面', '違い',
    ],
    summary: 'LINE、M-talk、管理画面、Journal Reportの役割を整理する。',
    content: [
      'LINE Reportは、店舗LINEで受け取るレシート・予約・予算・経費等を処理し、管理画面・売上分析・予約表・メディア・M-talk・Journal Reportへつなぐ店舗運用システムです。',
      'LINEはレシート画像、Excel、予約スクショ、予算登録、経費登録などの入口です。M-talkは社内チャットと店舗Bot機能の入口です。',
      '管理画面は店舗・ルーム設定、権限、配信先等を管理します。売上分析はLINEレシート等の集計と予算進捗を表示します。',
      'Journal ReportはPOS電子ジャーナル（.lzh/.jnl）を確定売上の正本にし、保存レポート、資料、店舗情報、AI分析・AIチャット・予測を扱います。',
      '同じ「売上」でも、LINE Reportの売上分析とJournal Reportの電子ジャーナル分析は入口と正本が異なります。正確なPOS明細・商品分析はJournal Reportを使います。',
    ].join('\n'),
  },
  {
    id: 'screens-and-access',
    code: 'SYS-02',
    categoryId: 'ecosystem',
    title: '主な画面とログイン・店舗範囲',
    keywords: [
      '画面', 'ページ', 'どこ', '入口', 'ログイン', '管理トークン', 'ワンタイムリンク',
      '店舗選択', '他店', '自店', 'アクセス', 'url', 'メニュー',
    ],
    summary: 'どの画面を何に使い、どの店舗まで見られるかを説明する。',
    content: [
      '主な画面は、管理画面、売上分析、予約表、メディア、会話検索、M-talk、M-talk管理、Journal Report、LINE Report電子ジャーナルです。',
      '管理系ページは管理トークン、またはLINE等から発行される期限・用途付きのワンタイムリンクでログインします。',
      '店舗用ログインは自店舗だけに固定され、他店舗を指定しても表示できません。全店切替や横断集計は本部管理者向けです。',
      '公開ページから業務DBを直接読むのではなく、認証・店舗範囲を確認する管理APIを通して取得します。',
    ].join('\n'),
  },
  {
    id: 'line-command-index',
    code: 'SAL-01',
    categoryId: 'sales',
    title: 'LINEコマンドと入力の使い分け',
    keywords: [
      'lineコマンド', 'コマンド', '予算登録', '売上検索', '検索', 'レシート修正',
      'レシート削除', '登録確認', 'キャンセル', '設定', '数字', '6桁', '8桁',
    ],
    summary: 'LINEで送る言葉・数字・画像がどの機能を起動するかを説明する。',
    content: [
      '主な完全一致コマンドは「予算登録」「経費」「設定」「売上検索」「検索」「会話検索」「予定検索」「メディア検索」「レシート修正」「レシート削除」「登録確認」「キャンセル」です。',
      '何も操作中でない状態で20から始まる8桁（YYYYMMDD）を送ると日次売上、6桁（YYYYMM）を送ると月次売上を照会します。',
      '予算登録中の6桁は対象月、次の数値は予算額として扱います。予算を入れるときは必ず最初に「予算登録」と送ります。',
      '会話・予定・メディア検索は1対1専用です。店舗ルームで使える検索は売上検索です。',
      '進行中の予算・経費・検索・修正は「キャンセル」「中止」「やめる」で終了できます。',
    ].join('\n'),
  },
  {
    id: 'receipt-registration',
    code: 'SAL-02',
    categoryId: 'sales',
    title: 'LINEレシート解析・売上登録',
    keywords: [
      'レシート', '売上登録', '画像', '精算', 'ocr', '解析', '組数', '客数', '客単価',
      '反射', '登録されない', '期間集計', '日計',
    ],
    summary: 'レシート画像を売上へ登録する流れと対象外画像を説明する。',
    content: [
      '店舗LINEルームへ精算レシート画像を送ると、店舗・日付・売上・組数・客数等を解析し、確認カードを返して売上へ保存します。',
      '数値が違う場合はカードの「この結果を修正」、不要なら「この解析結果を削除」を使います。',
      '反射や傾きが強い写真は誤読しやすいため、まっすぐで文字が読める画像を送ります。',
      'メニュー表や複数日をまとめた期間集計レポートは日々の売上として登録しません。単一日の精算レシートは通常どおり対象です。',
      '同じ画像の二重送信や同日データには、重複防止・加算・置換の確認経路があります。',
    ].join('\n'),
  },
  {
    id: 'receipt-correction-duplicate',
    code: 'SAL-03',
    categoryId: 'sales',
    title: 'レシート修正・削除・同日重複',
    keywords: [
      '修正', '訂正', '削除', '重複', '加算', '置き換え', '上書き', '同じ日',
      '会計組数', '値を空', '戻る', '保存して終了',
    ],
    summary: '解析後の数値修正、削除、同日重複の選択方法を説明する。',
    content: [
      '修正はカードの「この結果を修正」または「レシート修正」から開始し、項目番号→新しい値、または「6 3」のように番号と値を一度に送ります。',
      '複数項目を続けて直せます。完了時は「すべて保存して終了」、選び直しは「戻る」、取消は「キャンセル」です。',
      '値を空にするときは「なし」「削除」「クリア」を使います。',
      '同じ日のレシートがある場合は「加算」「置き換え」「中止」から選びます。解析結果そのものを消すときは削除操作を使います。',
    ].join('\n'),
  },
  {
    id: 'budget-sales-query',
    code: 'SAL-04',
    categoryId: 'sales',
    title: '月間予算・日別配分・売上照会',
    keywords: [
      '月間予算', '予算', '日別予算', '曜日重み', '休日', '店休日', '祝日',
      '売上照会', '日次売上', '月次売上', '着地予測', '進捗',
    ],
    summary: 'LINE予算登録と管理画面の日別配分、数字だけの売上照会を区別する。',
    content: [
      'LINEで「予算登録」→対象月6桁→予算額の順に送ると、月間総予算を登録します。ルーム側で予算登録許可が必要です。',
      '既存予算や売上がある月は上書き確認が出ます。30分操作がない場合は最初からやり直します。',
      '曜日重み、祝日・祝日前日、店舗休日、特定日の日別予算は売上分析画面の「予算・日別配分を設定」で調整します。',
      '何も操作中でなければ、8桁はその日の売上、6桁はその月の売上照会です。予算登録とは別機能です。',
      '日別配分は中間報告・月末レポート・売上進捗・着地予測の基準になります。',
    ].join('\n'),
  },
  {
    id: 'excel-analytics-reports',
    code: 'SAL-05',
    categoryId: 'sales',
    title: 'Excel取込・売上分析・定期レポート',
    keywords: [
      'excel', 'エクセル', '売上分析', 'analytics', 'アップロード', '対象期間',
      '店舗キー', '中間報告', '月末レポート', '配信', '曜日', '予算進捗',
    ],
    summary: 'Excel売上取込、分析画面、定期レポート配信を説明する。',
    content: [
      '所定Excelは店舗キー、対象期間YYYYMM、店舗名、日付・売上・税・客数・組数・客単価を持ち、LINEルームまたは管理画面から取り込みます。',
      '取込は対象期間を置き換える方式で、0や空欄の日は既存データを消すため、期間と店舗キーを確認してから確定します。',
      '売上分析画面では店舗・月を選び、売上、予算進捗、日別配分等を確認します。',
      '売上中間報告は原則毎月16日、月末レポートは翌月1日に指定ルームへ配信し、ON/OFFや送信先はルーム設定で管理します。',
    ].join('\n'),
  },
  {
    id: 'reservation-flow',
    code: 'RSV-01',
    categoryId: 'reservations',
    title: '予約メール・スクショ・予約表',
    keywords: [
      '予約', 'gmail', '食べログ', '一休', 'スクショ', '電話予約', '予約表',
      '予約回数', 'キャンセル回数', '過去の予約', '変更', 'カレンダー', '本日の予約',
    ],
    summary: '自動メール予約と手動スクショ予約、予約表・履歴の関係を説明する。',
    content: [
      '食べログ・一休等の予約メールはGmailから自動取得され、店舗LINEへの通知とGoogleカレンダー・予約表への登録を行います。',
      'メールが来ない電話・店頭・他サイト予約は、予約確認画面のスクショを店舗LINEへ送り、確認カードの「この内容で登録」で保存します。',
      'スクショでは来店日時、氏名、電話、人数、コース、卓、アレルギー、記念日、メモ等を読みます。氏名と電話の両方がある場合に予約回数へ算入します。',
      '予約変更は元予約を更新し、キャンセルは予約回数を減らしてキャンセル回数を増やします。予約回数は来店実績ではなく予約の正味数です。',
      'M-talkの「予約・予定」や予約表から閲覧・追加・変更・日付変更・キャンセルができます。毎朝の本日の予約配信はルーム設定に従います。',
    ].join('\n'),
  },
  {
    id: 'room-settings-permissions',
    code: 'OPS-01',
    categoryId: 'operations',
    title: 'ルーム設定・権限・セルフ設定',
    keywords: [
      'ルーム設定', '権限', '機能設定', 'ai返信完全無し', '予算登録を許可',
      'レシート解析結果', 'セルフ設定', 'パスワード', 'ワンパス', 'ゴミ箱', '復元',
    ],
    summary: '管理者設定、スタッフのセルフ設定、ルーム削除範囲を説明する。',
    content: [
      '管理画面の権限・機能設定で、添付保存、解析結果返信、修正返信、売上レポート、予算登録、予約配信等をルームごとに管理します。',
      '設定保存前は画面を強制再読込し、最新状態で保存します。「AI返信完全無し」でも登録確定に必要なレシート・予算等の返信は残る場合があります。',
      'セルフ設定を管理者が有効化すると、スタッフはLINEルームで「設定」と送り、24時間・1回限りのリンクとルームパスワードで、そのルームの安全なトグルだけ変更できます。',
      'M-talkルームはゴミ箱へ移動して復元でき、完全削除は権限と再入力確認が必要です。店舗固定ルームは通常の完全削除対象外です。',
    ].join('\n'),
  },
  {
    id: 'search-media',
    code: 'OPS-02',
    categoryId: 'operations',
    title: '検索・メディア・予定の探し方',
    keywords: [
      '会話検索', 'トーク検索', '予定検索', 'カレンダー検索', 'メディア検索',
      '画像検索', 'ファイル検索', '過去メッセージ', '横断検索', '検索できない',
    ],
    summary: '1対1検索と店舗ルームの検索範囲を区別する。',
    content: [
      '店舗ルームで使える検索は売上検索です。会話・予定・メディア検索は店舗Botとの1対1から使います。',
      '1対1検索では、権限のある複数ルームの会話・予定・画像・ファイルを横断して探せます。',
      'M-talkではトーク一覧上部から参加中ルームとメッセージを検索し、右上メニューから履歴検索、予約・予定、メディアライブラリを開けます。',
      '検索結果は参加・閲覧権限の範囲内だけです。参加前メッセージは取得できません。',
    ].join('\n'),
  },
  {
    id: 'petty-cash',
    code: 'OPS-03',
    categoryId: 'operations',
    title: '小口現金・経費・出金',
    keywords: [
      '小口', '小口現金', '経費', '出金', 'レジ出金', '勘定科目', '税率',
      '外税', '内税', '消耗品', '仕入', 'csv',
    ],
    summary: '小口ページとLINE経費登録の入口・計算・確認方法を説明する。',
    content: [
      '小口現金は売上・予約とは別の台帳で、店舗・月ごとに出金日、品目、勘定科目、価格、取扱者、メモを記録します。',
      '税率は勘定科目を基準に表示し、外税・内税を選ぶと本体・税額・出金額を計算します。登録後は月合計・科目別合計を確認できます。',
      '小口ページへレシート画像をドロップすると解析結果を入力欄へ反映します。必ず金額・税率・科目を確認してから登録します。',
      'LINEでは「経費」「出金」「小口」等を先に送り、続けて出金レシート画像を送ります。別店舗レシートでは「経費として記録」ボタンが出る場合があります。',
      '通常の自店舗精算レシートは売上扱いであり、経費コマンドを使わない限り小口へ混ぜません。',
    ].join('\n'),
  },
  {
    id: 'journal-overview-tabs',
    code: 'JRN-01',
    categoryId: 'journal-core',
    title: 'Journal Reportの目的と画面',
    keywords: [
      'journal report', 'ジャーナルレポート', '目的', 'タブ', '使い方タブ',
      '変換タブ', '店舗情報タブ', '資料タブ', '保存済みレポート', '何ができる',
    ],
    summary: 'Journal Reportの目的、4タブ、分析ツールを説明する。',
    content: [
      'Journal ReportはPOSの.lzh/.jnlを再現可能な確定売上の正本にし、その上で店舗情報・資料・予約事実を組み合わせて分析するアプリです。',
      '主なタブは「使い方」「変換」「店舗情報」「資料」です。',
      '変換タブには取込、保存済みレポート、売上予測、予測履歴・MAPE、AI分析履歴、AIチャットPDF履歴、AIチャット、ゴミ箱等があります。',
      'レポートを開くとHTML保存、印刷・PDF、標準AI分析、AIチャット、テーマ切替を利用できます。',
      'LINEレシートOCR本体、会話検索、フードコート日報は別機能です。',
    ].join('\n'),
  },
  {
    id: 'journal-import-reports',
    code: 'JRN-02',
    categoryId: 'journal-core',
    title: 'ジャーナル取込・保存レポート・原本',
    keywords: [
      'lzh', 'jnl', 'ジャーナル取込', '変換', 'ドロップ', '解凍', '文字コード',
      '保存レポート', '日別', '月間', '原本', '再アップロード', '修復', '重複',
    ],
    summary: 'POS原本の取込から日別・月間レポート保存までを説明する。',
    content: [
      '変換タブへ.lzh/.jnlまたは月フォルダをドロップすると、ブラウザ内で解凍、制御コード除去、文字変換、伝票整理、売上集計を行います。',
      'ログイン済みなら日別・月間レポートをクラウドへ自動保存します。再アップロードは同じレポートを更新し、重複を増やさない経路があります。',
      'LINE Report電子ジャーナルからLZHを登録した場合も、対象月全体を読み直してJournal Reportの保存済み日別・月間レポートを作成・更新します。',
      '原本がある日は原本を優先し、原本がない日だけ保存レポートで補完するため、同じ売上を二重計上しません。',
      '古い解析版は再作成を促します。印刷やAI分析は現行解析版を前提にします。',
    ].join('\n'),
  },
  {
    id: 'journal-source-of-truth',
    code: 'JRN-03',
    categoryId: 'journal-core',
    title: '確定集計・カテゴリ・ランチ／ディナー',
    keywords: [
      '確定集計', '正本', 'saved_reports', 'pos_journal', '伝票明細', '商品点数',
      'ランチ', 'ディナー', '16時', 'フード', '飲料', '室料', 'カテゴリ',
    ],
    summary: 'Journalの数字の根拠と集計上の基本ルールを説明する。',
    content: [
      '数値の正本は保存済みレポートとジャーナル原本から作る確定集計です。資料やWeb情報を売上金額の出典にはしません。',
      '商品点数・金額は伝票明細を優先し、明細がない場合だけ要約値へフォールバックします。',
      '会計時刻16:00未満をランチ、16:00以降をディナーとして分けます。',
      '主なカテゴリはフード、飲料、室料です。商品名に「スパークリング」等が入っていても、それ自体を独立カテゴリとは扱いません。',
      'AIに足し算させず、サーバー側で確定集計した数値を質問文脈へ追加して回答させます。',
    ].join('\n'),
  },
  {
    id: 'journal-store-operations',
    code: 'JRN-04',
    categoryId: 'journal-core',
    title: '店舗情報・営業カレンダー・ワインml',
    keywords: [
      '店舗情報', '定休日', '定休', 'ランチ', 'ディナー', '特別営業',
      'カレンダー', 'イベント', '過去売上同期', 'ワイン', 'ml', 'グラス', 'ボトル', 'ペアリング',
    ],
    summary: 'AIが参照する店舗前提、施策カレンダー、ワイン量換算を説明する。',
    content: [
      '店舗情報タブには定休日、ランチ／ディナー有無、特別営業ルール、営業メモ、施策・イベントカレンダーを店舗別に保存します。',
      'AIは定休日の売上ゼロを弱点扱いせず、分析期間と重なる施策・イベントを優先して解釈します。',
      '過去売上同期は店舗ごとの明示ONでのみ動き、他店舗へ自動的に広げません。',
      'ワイン量はグラス、固定750mlのボトル、ペアリング等の対象SKUだけを点数からml換算します。銘柄名だけのボトルは自動換算対象にしません。',
      '「どれくらいワインが出たか」が曖昧な場合は、点数・総ml・両方のどれを見たいか確認してから回答します。',
    ].join('\n'),
  },
  {
    id: 'journal-knowledge-documents',
    code: 'KNW-01',
    categoryId: 'journal-knowledge',
    title: '資料タブ・施策・メニュー資料',
    keywords: [
      '資料タブ', '資料登録', '施策', 'メニュー', '価格改定', 'イベント',
      'マニュアル', '添付', 'rag', 'チャンク', '有効', '無効', '論理削除',
    ],
    summary: '店舗資料の登録・検索・AIへの使われ方を説明する。',
    content: [
      '資料タブには施策、メニュー、価格改定、イベント、マニュアル、現場メモ等を登録し、期間・タグ・キーワード・有効状態で管理します。',
      'タイトル、概要または本文、任意の期間、画像・PDF・テキスト等の添付を保存できます。長文は検索用チャンクへ分割します。',
      '資料は売上の背景・要因を説明するために使い、金額の正本にはしません。資料由来は「登録資料によると」、推測は「これは推測」と分けます。',
      '既定削除は論理削除で、必要なら復元できます。添付は非公開保管し、閲覧時に一時URLを発行します。',
      'AIは分析期間と重なる資料と質問に関連する資料を選び、全資料目次は存在確認にだけ使います。',
    ].join('\n'),
  },
  {
    id: 'journal-line-memo',
    code: 'KNW-02',
    categoryId: 'journal-knowledge',
    title: 'LINE #メモ・#日報・添付資料登録',
    keywords: [
      '#メモ', '＃メモ', '#日報', '#note', 'lineメモ', '現場日報', '引用返信',
      '画像メモ', 'pdfメモ', '資料へ登録', '登録されない',
    ],
    summary: 'LINEから店舗資料へ現場メモや添付を登録する方法を説明する。',
    content: [
      '「#メモ」「#日報」「#note」は同義です。本文付きで送ると店舗資料へ自動分類して保存します。',
      '画像・PDF等を資料登録するときは、先に添付を送り、そのメッセージへ引用返信で「#メモ」と送ります。画像だけでは本文タグがないため資料登録されません。',
      '空の「#メモ」だけでは登録せず、使い方ガイドを返します。',
      '送信日時を資料期間として保存し、対象期間と重なる分析へ添付します。他月の投稿を類似度だけで混ぜません。',
      '成功後の資料はJournal Reportの資料タブで閲覧・編集します。LINE上だけで資料一覧は表示しません。',
    ].join('\n'),
  },
  {
    id: 'journal-ai-analysis',
    code: 'JAI-01',
    categoryId: 'journal-ai',
    title: '標準AI分析の根拠と出力',
    keywords: [
      '標準ai分析', 'ai分析', 'コンサル分析', '経営分析', 'ワイン戦略',
      'ダッシュボード', '履歴', '根拠', '外部知見', 'luna', 'claude',
    ],
    summary: '標準AI分析が何を根拠に、どの観点でレポートを作るかを説明する。',
    content: [
      '標準AI分析は確定売上、店舗情報、施策カレンダー、店舗資料、必要に応じた外部知見を分離して入力し、経営・売上・ワイン戦略のレポートを作ります。',
      '数値は確定集計だけを正本にし、資料や外部情報は背景・仮説として扱います。',
      'ランチ／ディナー、客単価、F/D比率、曜日・時間帯、商品、ワイン点数・ml、定休、施策との対応を重視します。',
      '根拠がない季節コースや施策を事実として断定しません。定休日を機会損失と誤診しません。',
      '生成結果はAI分析履歴へ自動保存され、ダッシュボードでは売上・客単価・F/D・昼夜・曜日・時間帯・売れ筋等を確認できます。',
    ].join('\n'),
  },
  {
    id: 'journal-ai-chat',
    code: 'JAI-02',
    categoryId: 'journal-ai',
    title: 'AIチャットで質問できる内容',
    keywords: [
      'aiチャット', 'ジャーナルに聞く', '質問', '期間比較', '月次推移',
      '客単価', '曜日', '時間帯', '改善案', 'pdfにする', 'clarifier', '確認',
    ],
    summary: 'AIチャットの質問範囲、曖昧質問の確認、PDF保存を説明する。',
    content: [
      '保存済みレポートとジャーナル横断検索を根拠に、期間比較、月次推移、商品点数・売上、客単価、曜日・時間帯、コース、予約vs飛び込み、改善案等を質問できます。',
      '期間・意図・ワインの単位が曖昧なときは、断定せず選択肢で確認します。',
      '「2026年1月から7月」は1月と7月だけでなく連続する全月として扱い、データがない月だけを明示します。',
      '回答下の「PDFにする」で質問＋回答の印刷用表示を開き、AIチャットPDF履歴へ保存します。',
      'M-talkからは1対1の入力欄「＋」→「ジャーナルに聞く」で同じJournal Report AIを開けます。',
    ].join('\n'),
  },
  {
    id: 'journal-product-course',
    code: 'JAI-03',
    categoryId: 'journal-ai',
    title: '商品・銘柄・商品コード・コース分析',
    keywords: [
      '商品', '銘柄', '商品コード', '下4桁', '0023', '2103', '売れ行き',
      '初出', '導入月', 'コード再利用', '別名', 'コース', 'ラインナップ', 'ランキング',
    ],
    summary: 'TOP外の商品、コード下4桁、名称変更、コース分析のルールを説明する。',
    content: [
      '売れ筋TOPにない商品でも、商品月次インデックスとジャーナル横断検索で月別点数・金額・初出を調べられます。',
      '商品コードはフルコードでも下4桁へ正規化して検索できます。「商品コード0023の2026年」を0023年と誤解しないよう、コードと期間を分離します。',
      '同じコードが別時期に別商品名へ再利用された場合、別名履歴として併記できますが、質問商品の実績へ勝手に合算しません。',
      'コース分析は一部の固有名だけでなく、コース全体のラインナップ、単価帯、月次販売、主力点数を確認します。',
      '商品ランキングでは大分類だけを商品として扱わず、質問対象の単品・コースを確定明細から選びます。',
    ].join('\n'),
  },
  {
    id: 'journal-reservations-forecast',
    code: 'JAI-04',
    categoryId: 'journal-ai',
    title: '予約・飛び込み・売上予測・MAPE',
    keywords: [
      '予約事実', '予約vs飛び込み', '飛び込み', '新規', 'リピート', 'チャネル',
      '食べログ', '一休', '予測', '売上予測', 'mape', '予測履歴', '誤差',
    ],
    summary: '予約データの扱いと、保存レポートを使う売上予測・精度確認を説明する。',
    content: [
      '予約分析は導入済み店舗・期間だけで、食べログ・一休・手入力の件数、人数、キャンセル、新規／リピート、月次等を使います。電話番号はAIへ出しません。',
      '飛び込みはPOS組数・客数から予約を差し引く推定であり、ノーショー、未通知予約、日付ずれ等があるため必ず推定と明記します。',
      '未導入店舗や未対応期間では予約節を無理に出しません。',
      '売上予測はカテゴリ付きの保存済み月間レポート系列を使い、前年・季節性・直近平均等を組み合わせて保存します。',
      '予測履歴では実績と比較し、MAPE（平均絶対パーセント誤差）で精度を確認します。',
    ].join('\n'),
  },
  {
    id: 'journal-history-admin',
    code: 'JAI-05',
    categoryId: 'journal-ai',
    title: '履歴・ゴミ箱・管理者機能',
    keywords: [
      '履歴', 'ゴミ箱', '復元', '論理削除', '保存済みレポート', '予測履歴',
      'ai分析履歴', 'チャットpdf履歴', '店舗横断', 'ai使用量', '管理者',
    ],
    summary: 'Journalの各履歴、復元、管理者だけの横断機能を説明する。',
    content: [
      '保存済みレポート、売上予測、AI分析履歴、AIチャットPDF履歴は論理削除でゴミ箱へ移し、復元できます。',
      'ゴミ箱中もレポートHTMLや資料添付は保持され、復元後に再利用できます。',
      '本部管理者は店舗横断サマリー、全店舗切替、AI使用量（トークン・概算費用）を確認できます。',
      '店舗スコープのログインでは、自店舗以外の横断機能は表示・利用できません。',
    ].join('\n'),
  },
  {
    id: 'foodcourt-overview-data',
    code: 'FCT-01',
    categoryId: 'foodcourt',
    title: 'フードコート分析の全体像とデータ',
    keywords: [
      'フードコート', 'marugo s', 'テナント', 'テナント一覧', '売上シェア',
      '東京ドーム', 'カナデビア', '後楽園', 'イベント', '天気', '動員数', 'データ',
    ],
    summary: 'フードコート分析が集める実績・イベント・天気・日報を説明する。',
    content: [
      'フードコート分析は、MARUGO Sを含むテナント実績、イベント、天気、日報、動員数を日付でそろえ、売上・客数・客単価・シェア・需要要因を確認する画面です。',
      'テナント一覧画像をLINE等から取り込み、各店の実績を保存します。基準店の日次正本はレシート集計の売上と手入力・日報等の客数を結合します。',
      '東京ドーム、カナデビアホール、後楽園ホール等のイベントと天気を日次へ結び、イベント規模や条件と実績を比較します。',
      '日報の施策・課題・動員数は事実や現場所感として使い、売上数値そのものを日報文章から作りません。',
      '画面には概要・AI分析、来客予測、日次分析履歴、週次レポート、AIフォールバック確認等があります。',
    ].join('\n'),
  },
  {
    id: 'foodcourt-ai-modes',
    code: 'FCT-02',
    categoryId: 'foodcourt',
    title: 'フードコート複数AI・Q&A・サマリー',
    keywords: [
      '複数ai', '5+1', '専門ai', '反証ai', '統合ai', '評価ai', 'q&a',
      '日次サマリー', '期間サマリー', '週次', 'オーケストレーション', '数字を作らない',
    ],
    summary: 'コード事前計算と専門・反証・統合AIの役割分担を説明する。',
    content: [
      'フードコートAIは、先にコードが売上・客数・客単価・シェア・相関・異常値・予測係数等を計算し、AIには解釈と文章化を担当させます。AI自身に数字を作らせません。',
      '専門AIは数値・他店比較、イベント・天気、運営改善を分担し、反証AIが言い過ぎや矛盾を確認した後、統合AIが現場向けの最終回答を作ります。',
      '任意の品質評価AIは回答を採点し、不合格時は改善点だけを統合AIへ戻します。専門AI全体を毎回再実行せず、品質とコストを両立します。',
      '分析モードは自由質問（Q&A）、日次サマリー、期間サマリー、週次報告です。Q&Aは表示日で時間軸を固定し、会話履歴と日報を参照できます。',
      '各AIが本来のモデルを使えず別モデルへ切り替わった場合は、フォールバック事象として記録し画面で確認できます。',
    ].join('\n'),
  },
  {
    id: 'foodcourt-forecast-evolution',
    code: 'FCT-03',
    categoryId: 'foodcourt',
    title: '来客予測・MAPE・AI学習進化',
    keywords: [
      '来客予測', '予測客数', '予測売上', '14日', 'mape', '予測誤差',
      '学習', '進化', 'モデル選択', 'glm', 'ポアソン', '乗算モデル', '毎朝5時', '毎日5時',
    ],
    summary: '2種類の予測モデル、自動選択、14日予測と進化画面を説明する。',
    content: [
      '来客予測は蓄積実績、曜日、イベント、天気、動員数等を使い、客数と売上の今後14日を作ります。',
      'レガシー乗算モデルとポアソン回帰GLM等をバックテストし、拡張窓MAPEが良いモデルを自動採用します。',
      '毎日の学習処理で係数・予測・精度履歴を更新します。データが増えるほど検証材料は増えますが、必ず精度が上がると断定はしません。',
      'AI学習進化ページでは客数・売上MAPE、学習データ量、採用モデル、信頼度、学習曲線、品質基準、自己進化の準備状況を確認します。',
      'MAPEは低いほど誤差が小さい指標です。基準を下回っても予測を停止せず、継続学習します。',
    ].join('\n'),
  },
  {
    id: 'foodcourt-daily-weekly',
    code: 'FCT-04',
    categoryId: 'foodcourt',
    title: 'フードコート日報・日次履歴・週次報告',
    keywords: [
      'フードコート日報', '日報', '担当者', '施策', '客数考察', '売上考察',
      '動員数', '課題', '申し送り', '週次報告', '週次レポート', 'アーカイブ',
    ],
    summary: '日報入力内容と、AI分析・週次レポートへの接続を説明する。',
    content: [
      'フードコート日報では日付・担当者、施策、客数考察、売上考察、動員数、天気・イベント特記、課題、翌日への申し送り、自由メモを保存します。',
      'カレンダーで日報のある日を確認し、履歴一覧から再表示・編集・削除できます。実売上KPIはAPIから表示します。',
      '日報の動員数は分析画面と予測特徴量へ連携し、日報文章はQ&A・日次・期間・週次分析の背景へ使います。',
      '日次分析履歴と週次レポートはアーカイブから再表示でき、週次報告では日次推移、売上シェア、テナント別ランキング、AI経営アドバイス等を確認します。',
      '日報の自己評価は事実ではなく仮説として実績と照合し、整合・不整合を分けて扱います。',
    ].join('\n'),
  },
  {
    id: 'store-reviews',
    code: 'REV-01',
    categoryId: 'reviews',
    title: '自店舗Google口コミ',
    keywords: [
      '自店舗口コミ', 'google口コミ', 'レビュー', '評価', '口コミ件数',
      'place id', '店舗検索', '口コミ更新', '登録解除', '店舗理解資料',
    ],
    summary: '自店舗のGoogle Place登録、評価・件数・抜粋、更新を説明する。',
    content: [
      '口コミ・競合分析ページでは、自店舗のGoogle Placeを店舗名検索またはPlace IDで登録し、評価、口コミ件数、取得日時、口コミ抜粋を確認できます。',
      '「自店舗口コミを更新」で最新情報を取得し、不要な登録は解除できます。自店舗口コミは競合口コミと別枠で管理します。',
      '自店舗の業態・特徴をまとめた店舗理解資料と競合辞典を保存し、周辺競合候補の優先順位や分析文脈に使います。',
      '口コミは売上確定値ではなく外部評価の補助情報です。評価変化と売上の因果を、口コミだけで断定しません。',
    ].join('\n'),
  },
  {
    id: 'competitor-reviews',
    code: 'REV-02',
    categoryId: 'reviews',
    title: '周辺競合・口コミ・競合圧力',
    keywords: [
      '競合', '周辺競合', '競合店', '競合口コミ', '競合圧力', '登録競合',
      '近隣検索', 'google place id', 'ai競合', 'ai除外', '売上分析から外す',
    ],
    summary: '競合店の登録・周辺検索・口コミ取得と補助指標の扱いを説明する。',
    content: [
      '競合店は店名またはGoogle Place IDで追加でき、周辺検索から候補をまとめて登録することもできます。',
      '登録後はGoogle評価、口コミ件数、口コミ抜粋等を更新し、登録済み競合一覧と競合圧力の補助指標へ反映します。',
      '店舗理解資料と競合辞典を使い、候補が実際の競合に近いかをAI分類し、「AI:競合」「AI:除外」等で確認できます。',
      '競合でない店舗は売上分析から外せます。口コミ・競合情報は外部環境の補助材料であり、自店舗売上の確定値や直接因果の証明には使いません。',
    ].join('\n'),
  },
  {
    id: 'admin-console-approvals',
    code: 'ADM-01',
    categoryId: 'administration',
    title: '管理画面・接続設定・承認・ログ',
    keywords: [
      '管理画面', '接続設定', '利用状況', 'webhook設定', 'ログ', 'アクセス履歴',
      'ユーザー権限', '承認', '管理bot', '許可', '不許可', '新規ルーム', '自動連携',
    ],
    summary: '本部管理画面の主要タブとユーザー／ルーム承認の役割を説明する。',
    content: [
      '本部管理画面では接続設定、利用状況、Webhook別設定、ログ、アクセス履歴、LINEユーザー権限、店舗・ルーム機能等を管理します。',
      '新規ユーザーと新規招待ルームのBot利用は承認ゲートがあり、管理Botの許可／不許可操作または管理画面で管理します。',
      'ルームの自動連携（管理対象へ登録）と、Bot利用承認は別です。連携されても承認前はBot機能が止まります。',
      'M-talk管理画面はLINEユーザー管理とは別に、M-talk利用停止、論理削除、ルーム権限、テンプレート、一括設定、監査・復元、ルーム／Botのゴミ箱を扱います。',
      'グループにはLINE公式アカウントを1体しか参加させられないため、店舗Botの選択を混同しないようにします。',
    ].join('\n'),
  },
  {
    id: 'ai-usage-system-map',
    code: 'ADM-02',
    categoryId: 'administration',
    title: 'AI使用量・システムマップ・利用状況',
    keywords: [
      'ai使用量', 'ai使用料', 'トークン', '概算費用', '利用状況', 'db容量',
      'line push', 'システムマップ', 'graphify', 'obsidian', '構成図', '管理者のみ',
    ],
    summary: 'AI利用コストと、管理者向けシステム構造・利用量画面を説明する。',
    content: [
      'AI使用量ページでは、記録された実測トークンと概算費用を用途・期間等で確認し、フードコート分析の使用量も区分して表示します。',
      '管理画面の利用状況ではDB容量、LINE Pushの種類別・店舗別・ルーム別送信量等を確認できます。',
      'システムマップはGraphifyのコード・SQL関係図と、実行環境・業務AI・知識循環の構成を表示します。',
      'AI使用量とシステムマップは本部の全体管理者向けです。店舗・ルーム限定セッションでは利用できません。',
      '公開システムマップにはコード・SQL構造だけを載せ、顧客情報、投稿本文、レシート、添付等の実データは含めません。',
    ].join('\n'),
  },
  {
    id: 'accuracy-security-boundaries',
    code: 'SEC-01',
    categoryId: 'safety',
    title: '回答の正確性・データ保護・回答範囲',
    keywords: [
      '正確', '安全', 'セキュリティ', 'プライバシー', '非公開', '店舗スコープ',
      '他店舗', '根拠', '推測', '個人情報', '電話番号', '何に答えられる',
    ],
    summary: 'AIが答えてよいこと、実データを推測しないこと、店舗隔離を説明する。',
    content: [
      '使い方AIはLINE Report、M-talk、Journal Reportの機能・仕組み・操作を、この統合マニュアルに基づいて案内します。',
      '店舗の実売上・客数・客単価・商品実績等の現在値は持っていないため、推測で答えず「＋」→「ジャーナルに聞く」へ案内します。',
      'Journal AIの数値は保存済みレポートとジャーナル確定集計を正本とし、資料・Web情報を金額の出典にしません。',
      '店舗用ログインは自店舗へ固定され、他店舗データを閲覧できません。画像・原本・添付は非公開保存し、必要時だけ一時URLで表示します。',
      'マニュアルにない機能、最新の外部状態、実際の設定値は断定せず、管理者確認や対象画面での確認を案内します。',
    ].join('\n'),
  },
  {
    id: 'troubleshooting-routing',
    code: 'SEC-02',
    categoryId: 'safety',
    title: '困ったときの切り分けと案内先',
    keywords: [
      '困った', 'トラブル', 'エラー', '動かない', '来ない', '登録されない',
      '見えない', '送れない', 'ログインできない', 'どこに聞く', '確認方法',
    ],
    summary: '症状ごとに、設定・画像・権限・データ有無のどこを確認するかを示す。',
    content: [
      '返信・配信が来ない場合は、対象ルームの機能ON/OFF、利用承認、送信権限、配信先、最新画面で保存したかを確認します。',
      'レシート・予約スクショが認識されない場合は、反射・傾き・文字の読みやすさを確認して再送します。',
      'M-talkで送れない／見えない場合はM-talk全体の利用状態と、そのルームの閲覧・送信権限を確認します。',
      'Journalで数字がない場合は、対象店舗・期間、原本取込、保存済みレポート、解析版、資料の取得状態を確認します。データがないことと取得失敗を区別します。',
      '正確な店舗数値は使い方AIではなくJournal AIへ、設定変更や権限変更はM-talk管理者・本部管理者へ案内します。',
    ].join('\n'),
  },
]

function normalize(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[！!。、，,.・:：;；「」『』（）()［\][\]【】/／#＃_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function keywordScore(keyword: string, normalizedQuestion: string): number {
  const normalizedKeyword = normalize(keyword)
  if (!normalizedKeyword || !normalizedQuestion.includes(normalizedKeyword)) return 0
  if (normalizedKeyword.length >= 8) return 8
  if (normalizedKeyword.length >= 5) return 6
  if (normalizedKeyword.length >= 3) return 4
  return 2
}

function scoreSection(section: LineReportHelpSection, normalizedQuestion: string): number {
  let score = 0
  for (const keyword of section.keywords) score += keywordScore(keyword, normalizedQuestion)
  const normalizedTitle = normalize(section.title)
  if (normalizedTitle && normalizedQuestion.includes(normalizedTitle)) score += 10
  const category = LINE_REPORT_HELP_CATEGORIES.find((entry) => entry.id === section.categoryId)
  if (category) {
    for (const keyword of category.keywords) score += Math.min(3, keywordScore(keyword, normalizedQuestion))
  }
  return score
}

export function selectLineReportHelpSections(
  question: string,
  limit = 4,
): LineReportHelpSelection[] {
  const normalizedQuestion = normalize(question)
  if (!normalizedQuestion) return []
  return LINE_REPORT_HELP_SECTIONS
    .map((section) => ({ section, score: scoreSection(section, normalizedQuestion) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.section.code.localeCompare(b.section.code))
    .slice(0, Math.max(0, limit))
}

export function isLineReportHelpQuestion(question: string): boolean {
  const normalizedQuestion = normalize(question)
  if (!normalizedQuestion) return false
  const productWords = [
    'line report', 'lineレポート', 'journal report', 'ジャーナルレポート',
    '電子ジャーナル', 'レシート', '予算', '予約', '小口', '経費', '売上分析',
    '店舗bot', '管理画面', 'gmail', '食べログ', '一休', 'lzh', 'jnl',
    '資料タブ', '商品コード', 'mape', 'ジャーナルに聞く', 'フードコート',
    '日報', '口コミ', '競合', 'ai使用量', 'ai使用料', 'システムマップ',
  ]
  return productWords.some((word) => normalizedQuestion.includes(normalize(word))) ||
    selectLineReportHelpSections(question, 1).some((entry) => entry.score >= 4)
}

/** カテゴリと項目コードを短く一覧化する。AIの検索索引として毎回添付する。 */
export function buildLineReportHelpIndex(): string {
  return LINE_REPORT_HELP_CATEGORIES
    .map((category) => {
      const sections = LINE_REPORT_HELP_SECTIONS
        .filter((section) => section.categoryId === category.id)
        .map((section) => `${section.code} ${section.title}`)
        .join(' / ')
      return `【${category.code} ${category.title}】${category.description}\n${sections}`
    })
    .join('\n')
}

/** 人間が確認できるMarkdown版を、同じデータから生成する（手書き二重管理を防ぐ）。 */
export function renderLineReportHelpManualMarkdown(): string {
  const lines = [
    '# LINE Report / Journal Report AI統合マニュアル',
    '',
    '> この文書は `line_report_help_manual.ts` から自動生成します。直接編集せず、',
    '> `npm run help:update` で更新してください。',
    '',
    '## 目的',
    '',
    '- M-talkの1対1 AIが、M-talk・LINE Report・Journal Reportを横断して案内するための利用者向け正本です。',
    '- 資料自体は詳細に保ち、回答時は質問に関連する項目だけを選び、結論→手順／理由→注意点の順で簡潔に答えます。',
    '- 店舗の実売上・客数・客単価等は推測せず、入力欄の「＋」→「ジャーナルに聞く」で確定データを確認します。',
    '- シークレット、内部トークン、顧客の実データは含めません。',
    '',
    '## 区分索引',
    '',
    '| 区分 | 内容 | 項目 |',
    '|---|---|---|',
    ...LINE_REPORT_HELP_CATEGORIES.map((category) => {
      const sectionList = LINE_REPORT_HELP_SECTIONS
        .filter((section) => section.categoryId === category.id)
        .map((section) => `${section.code} ${section.title}`)
        .join('<br>')
      return `| ${category.code} ${category.title} | ${category.description} | ${sectionList} |`
    }),
    '',
    '## 回答ルール',
    '',
    '1. 質問された範囲だけを答え、索引全体をそのまま読み上げない。',
    '2. 最初に結論を1〜2文、その後に必要な手順・理由・注意点だけを示す。',
    '3. LINE Reportの売上分析とJournal Reportの電子ジャーナル分析は、入口・数値の正本・用途を分けて説明する。',
    '4. 質問が曖昧なら推測せず、確認質問を1つだけ行う。',
    '5. マニュアル外の機能・実際の設定値・最新の店舗数値は断定しない。',
    '',
  ]

  for (const category of LINE_REPORT_HELP_CATEGORIES) {
    lines.push(`## ${category.code} ${category.title}`, '', category.description, '')
    for (const section of LINE_REPORT_HELP_SECTIONS.filter(
      (entry) => entry.categoryId === category.id,
    )) {
      lines.push(
        `### ${section.code} ${section.title}`,
        '',
        `**要点:** ${section.summary}`,
        '',
        ...section.content.split('\n').map((paragraph) => `- ${paragraph}`),
        '',
        `**検索語:** ${section.keywords.join(' / ')}`,
        '',
      )
    }
  }

  lines.push(
    '## 関連する詳細正本',
    '',
    '- `docs/操作マニュアル.md`',
    '- `docs/JOURNAL-REPORT-FEATURES.md`',
    '- `docs/JOURNAL-AI-CHAT-RULES.md`',
    '- `docs/JOURNAL-STORE-KNOWLEDGE.md`',
    '- `docs/CHAT-TALK-GUIDE.md`',
    '- `docs/M-TALK-COMPLETE-GUIDE.md`',
    '- `docs/SECURITY.md`',
    '',
  )
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}
