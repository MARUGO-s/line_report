-- マルゴオット（marugootto）の個別レシート解析プロンプト。
-- マルゴオットは通常の売上レシートに加えて、POSの「期間集計（GP/グループ・期間）」レポート画像が
-- 送られることがある（例: 日付範囲 開始〜終了 / 構成比 / DRINK・FOOD等のグループ別点数）。
-- これは売上レシートではないため、売上に加算せず・返信もしない。
-- 仕組み: プロンプトで「期間/日付範囲/GP（グループ）を含む集計レポート」を kind=general・receipt=null とし、
-- summary を「期間集計レポート」で始めるよう指示 → line-webhook 側が summary のマーカーを見て
-- 売上加算・返信をスキップする（receipt_image の期間集計スキップ実装）。

insert into public.store_receipt_analysis_prompts (store_partition_key, prompt, enabled, updated_at)
values (
  'marugootto',
  $prompt$この店舗には、通常の1会計の売上レシートに加えて、POSの「期間集計レポート（GP（グループ）／期間）」の画像が送られることがあります。
画像内に「期間」「日付範囲」「GP（グループ）」のいずれかが含まれ、日付範囲の集計（構成比・グループ別点数/金額など）になっているものは、売上レシートではありません。
その集計レポートの場合は必ず次のようにしてください:
・kind は "general"
・receipt は null
・summary は必ず「期間集計レポート」という語で始める（例:「期間集計レポート（売上記録対象外）」）。
通常の1会計のレシート（1回の精算）は、従来どおり kind="receipt" として正しく解析してください。$prompt$,
  true,
  now()
)
on conflict (store_partition_key) do update
  set prompt = excluded.prompt,
      enabled = true,
      updated_at = now();
