# vendor

外部CDNを読まない方針のため、必要なライブラリはここに置いて自己ホストする。

| ファイル | 用途 | 版 | ライセンス |
|---|---|---|---|
| `chart.umd.min.js` | グラフ描画 | Chart.js | MIT |
| `xlsx.full.min.js` | M-talk の Excel 添付プレビュー | SheetJS CE 0.20.3 | Apache-2.0 |
| `mammoth.browser.min.js` | M-talk の Word 添付プレビュー | mammoth.js 1.8.0 | BSD-2-Clause |

`xlsx` と `mammoth` は合計1.5MB超あるため、`chat.html` から
`<script>` で常時読み込まず、その形式を実際に開いたときだけ
`loadVendorScript()` で遅延読込する。

取得元:
- SheetJS: https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js
- mammoth: https://unpkg.com/mammoth@1.8.0/mammoth.browser.min.js
