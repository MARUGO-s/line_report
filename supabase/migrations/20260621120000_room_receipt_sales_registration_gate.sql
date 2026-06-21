-- ルーム単位「売上のDB登録」ゲート（試運転ルームを本番テーブルから除外する）。
-- 背景: 1つの店舗チャネルに本番グループ＋試運転DMが同居すると、全ルームが同じ
--   line_receipt__<store> に書き込み、重複判定（店舗全体×レシート日付）で本番側が
--   毎回「既に登録」になる／売上集計にも試運転データが混入する。
-- 対策: ルームごとに「売上をDB登録するか」を持たせ、試運転ルームは OFF にする。
--   既定は true（従来どおり登録する）。OFF のルームは解析はしても本番テーブルへ保存しない。
alter table public.room_summary_settings
  add column if not exists receipt_sales_registration_enabled boolean not null default true;

comment on column public.room_summary_settings.receipt_sales_registration_enabled is
  '売上(精算)レシートをDB登録するか。false=試運転ルーム等で本番テーブルに保存しない（既定true）。';

-- ソバージュ: 本番＝グループ「ソバージュ売り上げ」(Cb73…) のみ登録。残り2つの個人DMは試運転＝登録対象外。
update public.room_summary_settings
  set receipt_sales_registration_enabled = false
  where room_id in (
    'U2f960782d417c00b70687142dc6aa373',
    'U2fe75912fd4f272787f5645d22fdedb9'
  );
