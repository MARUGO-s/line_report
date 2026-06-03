-- 月間総売上が ¥0 と誤表示される不具合のデータ掃除。
-- 原因: シート連携の取込(pullDailySheetEditsToManualMonthGross)が、日次シートのゼロ埋め行を
-- 月次集計して gross_sales_yen=0 の手入力レコードを line_sales_manual_month_gross に書き込んでいた。
-- 売上分析の合計は手入力を優先するため、この 0 が総売上を 0 で上書きし、組数・客数だけレシートに
-- フォールバックする（=「日別は出るのに月間合計だけ ¥0」）状態になっていた。
-- 取込側は集計 gross<=0 のとき行を作らないよう修正済み。ここでは既存の不正レコードを掃除する。
--
-- 掃除対象は「自動生成された汚染」のシグネチャに限定する:
--   gross_sales_yen = 0 かつ party_count / guest_count / operating_days_count が全て NULL。
-- 担当者が手入力した正規レコード（売上>0、または組数・客数・営業日数のいずれかが入力済み）は対象外。
DO $$
DECLARE
  v_count int;
  v_detail text;
BEGIN
  SELECT count(*),
         string_agg(store_partition_key || ' / ' || sales_month, ', '
                    ORDER BY store_partition_key, sales_month)
    INTO v_count, v_detail
  FROM public.line_sales_manual_month_gross
  WHERE gross_sales_yen = 0
    AND party_count IS NULL
    AND guest_count IS NULL
    AND operating_days_count IS NULL;

  RAISE NOTICE 'cleanup spurious gross=0 manual-month rows: count=%, rows=[%]',
    v_count, COALESCE(v_detail, '(none)');

  DELETE FROM public.line_sales_manual_month_gross
  WHERE gross_sales_yen = 0
    AND party_count IS NULL
    AND guest_count IS NULL
    AND operating_days_count IS NULL;
END $$;
