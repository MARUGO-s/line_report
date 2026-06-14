# ドキュメント索引（line_report）

本リポジトリの Markdown 一覧と、**用語の定義**・**読む順番**です。内容の矛盾を防ぐため、他ドキュメントもこの用語に揃えています。

**本番:** Supabase `hocbnifuactbvmyjraxy`（hocbn）／GitHub Pages `https://marugo-s.github.io/line_report/`

---

## 用語集（混同しやすいもの）

| 用語 | 意味 | 承認が要るか | 主なフラグ／設定 |
|------|------|--------------|------------------|
| **ルーム連携（自動連携）** | Webhook 受信でルームを店舗の管理対象として DB に登録する | **管理者承認は不要**（既定 ON） | `RECEIPT_ROOM_AUTO_LINK`、`room_summary_settings` への upsert |
| **ルーム承認（Bot 利用許可）** | そのルームでレシート・検索等の **Bot 機能を動かすか** | **要る**（新規ルームは待ち） | `room_summary_settings.bot_access_approved`、管理 Bot @392hdime |
| **ユーザー許可** | 1対1 友だちが Bot 機能を使えるか | **要る**（新規友だちは待ち） | `line_user_permissions.is_active`、管理 Bot |
| **ルーム横断（検索）** | 1対1 から、複数の LINE ルーム（`C…`/`R…`）のデータをまとめて検索 | — | `search_line_room_messages` で `p_room_id = null` |
| **店舗内横断（売上検索）** | 同一店舗 Webhook の `receipt_table` 内の全ルームのレシート | — | **Webhook はまたがない** |
| **Webhook 横断** | **しない**（受信・記録・売上検索は常にその店舗の Webhook に紐づく） | — | `line-webhook/{store_partition_key}` |

**重要:** ルームは **自動連携されても**、**新規**の招待ルームは `bot_access_approved = false` のまま機能が止まります。連携と承認は **別レイヤ** です（[LINE-USER-APPROVAL-SECURITY.md](./LINE-USER-APPROVAL-SECURITY.md) §6.2）。

---

## ドキュメント一覧

| ファイル | 読者 | 内容 |
|----------|------|------|
| [README-PAGES.md](./README-PAGES.md) | 運用・開発 | **入口** — Pages URL、hocbn、デプロイ、関連ガイドへのリンク |
| [操作マニュアル.md](./操作マニュアル.md) | 運用（店舗スタッフ） | LINE・管理画面のエンドユーザー操作手順（売上/レシート/予約/予算/小口現金）＋症状別トラブルシュート |
| [店舗運用修正記録.md](./店舗運用修正記録.md) | 開発・運用 | 不具合の原因→対策→反映→検証の運用ログ（newest-first・現役で随時追記） |
| [CHANGELOG-2026-05.md](./CHANGELOG-2026-05.md) | 開発 | 2026年5月の変更履歴（技術詳細・マイグレーション） |
| [LINE-SEARCH-PRESENTATION.md](./LINE-SEARCH-PRESENTATION.md) | 説明・プレゼン | LINE 検索（記録と検索、グループ／1対1、売上と会話の違い） |
| [LINE-USER-APPROVAL-SECURITY.md](./LINE-USER-APPROVAL-SECURITY.md) | 運用・説明 | 利用許可・ルーム承認・管理 Bot・管理画面連携 |
| [LINE-GROUP-BOT-IMPORTANT.md](./LINE-GROUP-BOT-IMPORTANT.md) | **必読** | グループは Bot **1体のみ**（LINE 仕様）／退出の誤解 |
| [ROOM-LINKING-GUIDE.md](./ROOM-LINKING-GUIDE.md) | **必読** | ルーム **自動連携**（承認なし）のリスクと無効化 |
| [ROOM-PERMISSION-DETAIL-GUIDE.md](./ROOM-PERMISSION-DETAIL-GUIDE.md) | 運用・開発 | 管理画面の権限（全体／店舗／個別）、表示名 |
| [ROOM-PERMISSION-TEST-CHECKLIST.md](./ROOM-PERMISSION-TEST-CHECKLIST.md) | QA | 権限・Webhook 設定の動作確認 |
| [LINE-RECEIPT-ANALYSIS.md](./LINE-RECEIPT-ANALYSIS.md) | 運用・開発 | レシート OCR・店舗 Webhook・保存フロー |
| [RESERVATION-GMAIL-GUIDE.md](./RESERVATION-GMAIL-GUIDE.md) | 運用・開発 | Gmail 予約 → LINE（**会話検索とは別**） |
| [README.md](../README.md) | — | **レガシー**（旧 LINE-WINE ローカルアプリ）。本番 LINE レポートは README-PAGES を参照 |
| [ocr-bridge/README.md](../ocr-bridge/README.md) | 開発 | OCR ブリッジ |
| [cloudflare-worker/README.md](../cloudflare-worker/README.md) | 開発 | Cloudflare Worker（Webhook 入口の代替） |

---

## おすすめの読む順番

1. [README-PAGES.md](./README-PAGES.md) — 本番 URL とデプロイ  
2. [LINE-GROUP-BOT-IMPORTANT.md](./LINE-GROUP-BOT-IMPORTANT.md) — グループに Bot を1体だけ  
3. [ROOM-LINKING-GUIDE.md](./ROOM-LINKING-GUIDE.md) — 自動連携の注意  
4. [LINE-USER-APPROVAL-SECURITY.md](./LINE-USER-APPROVAL-SECURITY.md) — 許可・承認  
5. [LINE-SEARCH-PRESENTATION.md](./LINE-SEARCH-PRESENTATION.md) — 検索機能の説明  
6. 必要に応じて [ROOM-PERMISSION-DETAIL-GUIDE.md](./ROOM-PERMISSION-DETAIL-GUIDE.md)、[LINE-RECEIPT-ANALYSIS.md](./LINE-RECEIPT-ANALYSIS.md)

---

## 仕様の単一ソース（コード）

| 領域 | 主なファイル |
|------|----------------|
| 店舗・Webhook URL | `pages-config.js` |
| LINE 検索 UI・待ち2分 | `supabase/functions/_shared/line_search_bot.ts` |
| 利用許可・管理 Bot | `supabase/functions/_shared/line_user_approval.ts` |
| ルーム自動連携 | `supabase/functions/_shared/auto_link_room.ts` |
| 店舗 Webhook 本体 | `supabase/functions/line-webhook/index.ts` |
| 管理 Bot Webhook | `supabase/functions/line-admin-webhook/index.ts` |

---

## 横断チェック（2026-05-28 時点で統一済み）

| 項目 | 統一内容 |
|------|----------|
| 検索待ち TTL | **2分**（種別選択後、キーワード1通のみ非記録） |
| グループの検索 UI | 4種メニューなし。**売上案内 Flex ＋ 売上ボタン1つ** |
| 1対1の検索 UI | **4ボタン** Flex |
| グループ Bot 数 | LINE 仕様で **1体まで**（2体目は参加不可） |
| 新規ルーム | 自動連携されるが **`bot_access_approved=false` まで機能停止** |
| 本番 DB | **hocbn** のみ（Gmail も hocbn） |

---

*最終更新: 2026-06-14（操作マニュアル・店舗運用修正記録を索引に追加。ソバージュ解析まとめは店舗運用修正記録へ統合済みのため削除。小口現金 petty_cash / 月次予算登録 / 予約スクショ取込 などの 2026-06 機能は各ガイド本文で参照）*
