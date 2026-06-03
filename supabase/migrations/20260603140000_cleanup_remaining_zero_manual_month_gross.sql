-- 月間総売上 ¥0 誤表示の追掃除（第2弾）。
-- 第1弾(20260603130000)は party/guest/opdays が全て NULL の汚染のみ削除した。しかし
-- シート連携は「日次シートに組数・客数だけ入り売上は空」のとき gross=0 だが party/guest が入った
-- レコードも生成しうる（例: bistrocavacava=ビストロ サヴァサヴァ 2026-06）。これらは第1弾の
-- 条件から漏れ、総売上だけ ¥0 に上書きされ続ける。
--
-- gross_sales_yen=0 はそもそも「手入力で総売上を 0 に固定する」意味だが、レシートに売上がある月では
-- 常に誤り（実売上が ¥0 に化ける）。手入力優先を解除する正しい操作はレコード削除（=レシート集計へ
-- フォールバック）であり 0 を残す理由が無い。よって残存する gross=0 レコードを組数・客数の有無に
-- かかわらず全て削除する。削除前に内容を NOTICE で監査ログに残す。
DO $$
DECLARE
  v_count int;
  v_detail text;
BEGIN
  SELECT count(*),
         string_agg(
           store_partition_key || ' / ' || sales_month
           || ' (party=' || COALESCE(party_count::text, 'NULL')
           || ', guest=' || COALESCE(guest_count::text, 'NULL')
           || ', opdays=' || COALESCE(operating_days_count::text, 'NULL') || ')',
           '; ' ORDER BY store_partition_key, sales_month)
    INTO v_count, v_detail
  FROM public.line_sales_manual_month_gross
  WHERE gross_sales_yen = 0;

  RAISE NOTICE 'cleanup remaining gross=0 manual-month rows: count=%, rows=[%]',
    v_count, COALESCE(v_detail, '(none)');

  DELETE FROM public.line_sales_manual_month_gross
  WHERE gross_sales_yen = 0;
END $$;
