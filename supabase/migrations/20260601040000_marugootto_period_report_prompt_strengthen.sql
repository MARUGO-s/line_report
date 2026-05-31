-- マルゴオット（marugootto）の期間集計レポート判定プロンプトを強化。
-- 背景: 直近、期間集計レポート画像を送っても「無反応」だった。原因は、ビジョンモデルが
--   kind=general までは従うものの、summary に判定マーカー「期間集計」を入れず（言い換え/省略）、
--   line-webhook 側の期間集計スキップ分岐が発火しなかったため。
--   （非レシート画像扱いに落ち、その店舗は「画像解析結果を送信」OFF のため返信も抑止＝無反応）。
-- 対策: summary の先頭に必ず固定マーカー「期間集計レポート」を置かせ、言い換え・省略を明確に禁止する。
--   line-webhook の検知正規表現 /期間集計|.../ がこれを確実に拾う。

insert into public.store_receipt_analysis_prompts (store_partition_key, prompt, enabled, updated_at)
values (
  'marugootto',
  $prompt$この店舗では、通常の1会計レシートのほかに、POSの「期間集計レポート」（期間／日付範囲の合計、構成比、GP（グループ）別の点数・金額など）が送られてくることがあります。

【最重要・必ず守る】画像に「期間」「日付範囲」「開始〜終了の日付」「構成比」「GP（グループ）」のいずれかがあり、1回の精算ではなく期間の集計だと判断したら、必ず次のJSONにしてください:
・kind は "general"（絶対に "receipt" にしない）
・receipt は null
・summary は必ず「期間集計レポート：このレシートは日々の売上ではないため登録していません」という文字列にする。
  - summary は必ず「期間集計レポート」という語で始めること。言い換え・要約・省略・翻訳は禁止。先頭の語を変えてはいけません。

通常の1会計のレシート（1回の精算）は、従来どおり kind="receipt" として正しく解析してください。$prompt$,
  true,
  now()
)
on conflict (store_partition_key) do update
  set prompt = excluded.prompt,
      enabled = true,
      updated_at = now();
