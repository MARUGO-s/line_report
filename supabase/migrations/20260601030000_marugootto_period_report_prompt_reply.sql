-- マルゴオット（marugootto）の期間集計レポート向けプロンプトを更新。
-- 変更点: 期間集計（GP/期間）レポートと判定したとき、summary を利用者向けの一文にする
--   （「このレシートは日々の売上ではないため登録していません（期間集計レポート）」）。
-- この summary は line-webhook 側で「期間集計」マーカー検知に使われ、売上登録はせず、
-- レシート解析返信の経路（AI返信完全無しでも送る）でリッチテキスト(Flex)通知として返信される。

insert into public.store_receipt_analysis_prompts (store_partition_key, prompt, enabled, updated_at)
values (
  'marugootto',
  $prompt$この店舗には、通常の1会計の売上レシートに加えて、POSの「期間集計レポート（GP（グループ）／期間）」の画像が送られることがあります。
画像内に「期間」「日付範囲」「GP（グループ）」のいずれかが含まれ、日付範囲の集計（構成比・グループ別点数/金額など）になっているものは、日々の売上レシートではありません。
その集計レポートの場合は必ず次のようにしてください:
・kind は "general"
・receipt は null
・summary は必ず「このレシートは日々の売上ではないため登録していません（期間集計レポート）」とする。
通常の1会計のレシート（1回の精算）は、従来どおり kind="receipt" として正しく解析してください。$prompt$,
  true,
  now()
)
on conflict (store_partition_key) do update
  set prompt = excluded.prompt,
      enabled = true,
      updated_at = now();
