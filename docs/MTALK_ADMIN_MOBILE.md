# M-talk Web管理画面：スマホ専用レイアウト

更新: 2026-11-04（JST）
この文書は2026-11-04のユーザー承認版仕様と事前検証記録。実際の配信状態はGitHub Pagesの対象commit・workflow結果とObsidianのリリース記録で確認する。

## 対象

- 添付画像はSafariで開かれた `public/chat-admin.html`。Flutterの `chat_admin_page.dart` ではない。
- Web正本: `line_report-main` / `MARUGO-s/line_report`。
- ベース: `182c5892e029aa06317073c8cd19483c52198ca3`。
- 公開統合時に既存mainの `77367bb6a6973df4e06b4af035527b050c040700` へrebase。別作業のプライバシーテンプレート本文は変更しない。
- 隔離作業ブランチ: `feat/mtalk-admin-mobile-20261104`。
- 保存先worktree: `/Users/yoshito/.hermes/worktrees/mtalk-admin-mobile`。
- 既存の作業コピーにある別機能の変更は取り込まず、origin/mainから作成したworktreeで実装。

## スマホでの画面構成

980px以下（スマホ縦・横、狭いタブレット）に専用レイアウトを適用。980px超の既存PC表示は維持。

1. コンパクトな上部ヘッダー。テーマ切替、ログアウト、既存Webリンクは「その他」にまとめる。
2. 下部の固定ナビで概要・ユーザー・ルーム・監査ログ・委任管理者を切替。権限による非表示は既存のまま。
3. 一画面に一つの管理項目を表示。元のsection/form/controlは保持し、入力途中の値を壊す再生成はしない。
4. ユーザーの横長テーブルを、本人情報・状態・各権限・操作が分かるカードへ再配置。
5. ルームは一覧から詳細を開く二段階。詳細から一覧へ戻るボタンを追加。メンバー権限は閲覧・送信・招待・管理のラベル付き項目にする。
6. 管理範囲・許可操作の長文は開閉可能にし、元の文言は省略せず確認できる。
7. 監査ログ、委任管理者作成、確認ダイアログ、権限閲覧・差分表示も画面幅内に配置。
8. ノッチ／ホームインジケーターのsafe-areaと動的viewport高を考慮。フォーム文字は16px、ダイアログの内容部分をスクロールし、操作フッターを確保。

## 実装上の境界

- `chat-admin-mobile.css`: 専用レイアウト。単に横はみ出しをhiddenで隠す対応ではない。
- `chat-admin.html`末尾の `script[data-admin-mobile-adapter]`: 表示アダプター。既存ボタン／リンク／フォームを複製せず再利用する。PCへ幅変更した際は元の場所へ戻す。
- 元からあるinline scriptとformは旧版とバイト同一。既存DOMと業務イベント設定の後に、表示専用のinline blockを追加する。
- 新adapterはfetch、認証情報取得・保存、API書込、input.checked変更を行わない。
- API・管理者認可・委任範囲・busy/inert・確認ダイアログ・送信payloadは既存処理を利用する。表示用data属性を認可として扱わない。
- 401と409は、従来処理がダイアログを閉じて再認証／再読込する。この既存仕様も変更していない。400・403・500での入力保持を含め、旧UIと新UIの挙動を比較した。
- Flutter、端末インストール、TestFlight、Android、本番DB、Edge Functionの配備は変更しない。ユーザーは見本確認後にWeb公開を承認。
- 初期の独立したJSを、レビュー済み本体バイトを変えず既存help分類済みHTMLへ収めた。公開直前に別作業でmainへ入ったプライバシーテンプレートのhelp分類漏れが既存Pages配信を失敗させていたため、分類1行だけ補完し、生成マニュアルを正規generatorで更新。ポリシー本文、DB、API実装、workflowは変更しない。
- shared分類ファイルの1行でもDB・全Edge配備が自動起動するため、squash commitの`[skip ci]`は自動push workflowを抑止する目的に限る。代わりに既存 `deploy-pages.yml` をmainへ明示dispatchし、`skip_tests=false`で静的検証と全CI相当を通してからPagesだけ配備する。検証自体はスキップせず、対象SHAの結果とEdge配備が起動していないことを読む。

## 検証

- 先に既存画面を実ブラウザーで実行し、390pxでユーザー行が画面幅を超えることを再現（RED）。修正後は同じ操作で収まることを確認（GREEN）。
- Chromium＋タッチ端末エミュレーションの15項目が成功。幅320/390/430/760、横向き844/956を含む。
- 下部ナビ、カード、ルーム一覧／詳細と戻る、メンバー権限、監査、委任フォーム、メニューが画面幅内に収まる。
- タブ切替とPC⇔スマホの幅変更で、委任フォームの未保存値とDOM identityを保持。
- ユーザー保存の200/400/401/403/409/500、メンバー権限更新のAPI送信内容をadapterなしの旧UIと比較して一致。
- 委任管理者で、本部専用ナビ／本部リンク／ユーザー編集が従来どおり非表示。
- ダイアログ操作部を高さ520pxのviewportでも確認。ただし実際のiOSキーボード表示の検証とは区別する。
- 1440pxのPCスクリーンショットはadapterなしとピクセル同一。
- `npm run check`成功。管理画面関連48テスト成功。
- 全テストinventoryを正確なベースworktreeと比較。機密環境変数を除外し、Denoの実通信をloopbackへ限定。旧版Node685＋Deno255、新版Node689＋Deno255、すべてexit0。関連48件は全体と重複するため加算しない。
- ブラウザーはAPI・認証境界を架空fixtureへ置換し、外部通信を遮断。実ユーザーのログイン・業務データ更新・権限変更は行わない。
- 実機Safari／利用者による見た目・操作感の受入は未確認。Chromiumエミュレーション成功をSafari実機の成功と呼ばない。

## 再検証

```sh
npm run check
npm run test:structure
node --test tests/chat_admin*.test.mjs tests/html_inline_scripts.test.mjs tests/ux_mobile_layout.test.mjs
npm run test:chat-admin-mobile:browser
```

ブラウザーテストはPlaywrightが利用可能な環境で実行する。既存インストールを使う場合は `PLAYWRIGHT_MODULE_PATH` にモジュールのindex.mjs、必要なら `PLAYWRIGHT_CHROMIUM_EXECUTABLE` にChrome実行ファイルを指定する。新しい本番依存は追加していない。`ADMIN_SCREENSHOT_DIR` で証跡出力先を指定できる。

初期独立レビューは重大指摘なしで合格し、製品・テスト6ファイルのsnapshot一致を親が確認した。最終梱包ではJS本体をバイト同一でHTMLへ移し、全テストと15項目のブラウザー検証を再実行して成功。公開時はPR／配信workflow／公開HTMLとCSSの読戻しを別々に検証する。見本画像は架空データの実画面で、実データを使った業務受入とは区別する。
