# MARUGO S グルメサイト週報 → LINE（marugo-gourmet-weekly-line）

MARUGO S（東京ドーム）のグルメサイト掲載・口コミ分析レポート（HTML）を毎週 GitHub Pages に公開し、
そのリンクを LINE グループ「マルゴエス運営チーム」（`C51a3c2386cb1fc4247139bed89d45f52`）へ 1 通送る仕組みです。
毎週土曜 10:00 ごろ（日本時間）、Grok Bot の定期作業がレポートを作り直してから、共有の作業用コンピューターで次を実行します。

```bash
/workspace/line_report_main/scripts/marugo-gourmet-weekly.sh \
  --html /workspace/MARUGO-S_gourmet_report.html \
  --summary $'食べログ 3.20（口コミ30件・保存381人）\n…\n…' \
  [--date YYYY-MM-DD] [--dry-run]
```

| 段階 | 内容 |
| --- | --- |
| 公開 | `public/marugo-s/gourmet-report/<日付>.html` と `latest.html` を main へ push（専用 clone `~/.marugo-line/line_report-publish`）。`noindex` を付ける |
| 待機 | `https://marugo-s.github.io/line_report/marugo-s/gourmet-report/<日付>.html` が 200 で同じ内容を返すまで（既定 12 分） |
| 送信 | Edge Function `marugo-gourmet-weekly-line` が本文 `【MARUGO S グルメサイト週報 YYYY/MM/DD】` ＋要約（3行まで）＋URL を組み立てて push |
| `--dry-run` | 公開・待機まで行い、関数を `dry_run: true` で呼んで本文・送り先・トークンの有無・ロックダウン・送信済みを表示（LINE へは送らない） |

## Edge Function

- `POST /functions/v1/marugo-gourmet-weekly-line`、`verify_jwt = false`。`Authorization: Bearer <キー>` の SHA-256 を
  `marugo_gourmet_weekly_line_auth`（1行・hex のみ）と固定時間比較。キー本体は作業用コンピューターの `~/.marugo-line/gourmet_weekly_key`（600）だけにある。
- 宛先は固定（引数で変えられない）。URL は上の公開場所（`<report_date>.html` か `latest.html`）だけ、送る前に 200 を確認。
- 要約は 3 行・各 160 文字まで、URL・メールアドレス・電話番号らしき文字列は 400。
- LINE トークンはルームの店舗キー（`room_summary_settings.receipt_report_store_partition_key`、現在 `marugos`、無ければ `marugos`）の
  `LINE_CHANNEL_ACCESS_TOKEN__MARUGOS`（無ければ共通）。東京ドーム週次配信・レシート中間報告が同じグループへ送っているものと同じ Bot。
  `MARUGOSECOND_PUSH_LOCKDOWN` は店舗キー `marugosecond` だけが対象なので、このグループには影響しない。
- 二重送信防止: `marugo_gourmet_weekly_line_sends`（ルーム×日付で 1 回）。送信前に確保し、LINE が失敗したら消す。スクリプト側も `~/.marugo-line/gourmet-weekly-sent/<日付>` を残す。

## キーの入れ替え

```bash
umask 077; openssl rand -hex 32 | tr -d '\n' > ~/.marugo-line/gourmet_weekly_key
tr -d '[:space:]' < ~/.marugo-line/gourmet_weekly_key | sha256sum | cut -d' ' -f1   # 登録する hex（キー本体は表示しない）
```

hex を `insert into public.marugo_gourmet_weekly_line_auth (id, key_sha256) values (1, '<hex>') on conflict (id) do update set key_sha256 = excluded.key_sha256, created_at = now();` で登録する（SQL エディタ／service_role）。

配備: main への push で Actions が migration `20261111130000_marugo_gourmet_weekly_line.sql` と関数を配備します。新しい Edge Secret はありません。
