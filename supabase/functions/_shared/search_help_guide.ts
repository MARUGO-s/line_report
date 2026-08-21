/** 検索メニューの「使い方（全機能）」で返す、依存のない軽量Flex生成。 */
export function buildAllFeaturesGuideFlex(includeConversationSearch = true): Record<string, unknown> {
  const h = (text: string): Record<string, unknown> => ({ type: 'text', text, weight: 'bold', size: 'sm', wrap: true, margin: 'md' })
  const d = (text: string): Record<string, unknown> => ({ type: 'text', text, size: 'xs', color: '#666666', wrap: true, margin: 'xs' })
  return {
    type: 'flex',
    altText: '使い方ガイド（できること一覧）',
    contents: {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: '📖 使い方ガイド', weight: 'bold', size: 'lg', wrap: true },
          { type: 'text', text: 'このBotでできること一覧です。', size: 'xs', color: '#888888', wrap: true, margin: 'sm' },
          h('🔍 検索（1対1トーク）'),
          d(includeConversationSearch
            ? '「検索」と送ると 会話／予定／メディア／売上 のボタンが出ます。種類を選んでキーワードを送ると結果が返ります。売上は日付8桁(例 20260521)・月6桁(例 202605)。'
            : '「検索」と送ると 予定／メディア／売上 のボタンが出ます。種類を選んでキーワードを送ると結果が返ります。会話はトーク一覧上部の検索欄から検索します。売上は日付8桁(例 20260521)・月6桁(例 202605)。'),
          h('🧾 レシート → 売上（店舗トーク）'),
          d('レシート画像を送ると自動で売上登録。「この結果を修正」で修正、削除も可能です。'),
          h('🗒️ 過去の売上（日次売上Excel・店舗トーク）'),
          d('日次売上のExcel(.xlsx/.csv)を店舗トークに送ると、過去日の売上をまとめて登録。新しい日付は自動登録、既存がある期間は確認カードで置き換え。テンプレートが必要な場合は「日別売上管理表」または「売上管理表テンプレート」と送るとダウンロードできます。レポート・売上検索・分析に反映されます。'),
          h('💰 予算登録（店舗トーク）'),
          d('「予算登録」と送ると会話形式で月予算を登録できます（有効なルームのみ）。'),
          h('⚙️ 設定（店舗トーク）'),
          d('「設定」と送るとそのルームの権限設定ページのリンクが届きます（有効なルームのみ）。'),
          h('📊 自動レポート'),
          d('中間（毎月16日10時）・月末（翌月1日10時）に売上集計を自動でお届けします。'),
          h('📅 予約通知'),
          d('Gmail予約・当日予約を自動でLINE通知します。予約カレンダーのログインリンクが期限切れ・使用済みになった場合は、対応する店舗トークで「予約確認」と送ると新しいリンクが届きます。'),
          h('🆔 自分のID'),
          d('「ID確認」と送ると自分のユーザーIDを表示します（管理Bot）。'),
        ],
      },
    },
  }
}
