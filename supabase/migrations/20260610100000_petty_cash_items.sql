-- 小口現金: 1レシートに「品目ごとの勘定科目・税率」を持てるよう items(jsonb) を追加。
--   items = [{ n:品目, p:税抜価格(int), acct:'shokuzai'|'shomohin'|'alcohol', rate:8|10 }, ...]
--   - 1枚のレシートで 食材(8%)＋消耗品(10%)＋アルコール(10%) などの混在に対応（科目・税率は品目ごと）。
--   - amount_yen(税込合計) / tax_yen(税額) は従来どおり集計の主軸として保持（items から導出して保存）。
--       本体 = Σ p、税 = Σ round(p×rate/100)（品目ごとに丸めてから合算）、出金額 = 本体 + 税。
--   - 旧データ（items が null）は item テキスト＋category＋amount_yen で従来表示にフォールバック。
alter table public.petty_cash_entries
  add column if not exists items jsonb;

-- LINE取込の確認待ち(pending)にも品目内訳を保持し、記録時に entries へ引き継ぐ。
alter table public.petty_cash_pending
  add column if not exists items jsonb;
