-- バルぺロタ（barpelota）のレシート解析プロンプトを精算フォーマット専用に強化。
-- 目的: 精算（レジ締め/日計）レシートで「客数」が他の取引数/点数と取り違えられ抽出できない問題を是正。
-- 客単価はコード側（receipt_parse.ts）が「合計 ÷ 客数」で自動計算するため、本プロンプトでは
-- unit_price を出力させず（=コード計算を確実に発火）、客数の確実な抽出に集中させる。
-- 既定プロンプト（コード側）に末尾連結される「店舗固有の補足」を上書きする。

insert into public.store_receipt_analysis_prompts (store_partition_key, prompt, enabled, updated_at)
values (
  'barpelota',
  $prompt$このレシートは「精算（レジ締め・日計）」形式です。次の対応で必ず抽出してください。
・gross_sales（総売上）=「合計」の金額（税込）。「小計」「支払い」「現金」「クレジット」「お預り」「お釣り」「入出金」「取置き」は使わない。
・net_sales（純売上）=「純売上」の金額。
・tax_amount（消費税）=「消費税」の金額（内税額＋外税額）。
・party_count（会計組数）=「総取引数」の数値。
・guest_count（客数）=「客数」というラベルのすぐ右の数値だけを入れる（例:「客数 43」なら 43）。
  重要: 「総取引数」「通常取引数」「現金取引数」「クレジット取引数」「取消取引数」「販売点数」「返品点数」の数値は guest_count に絶対に入れない。これらは客数ではない。
・unit_price（客単価）は必ず null（出力しない）。客単価はシステムが「合計 ÷ 客数」で自動計算する。
・店名は「バルぺロタ」。
金額はカンマ・¥を除いた整数。客数・組数は整数。読めない項目は null。$prompt$,
  true,
  now()
)
on conflict (store_partition_key) do update
  set prompt = excluded.prompt,
      enabled = true,
      updated_at = now();
