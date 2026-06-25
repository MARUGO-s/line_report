-- ============================================================
-- フードコート分析の「基準店(marugoS)日次の正本」ビュー。
--
-- 背景: 従来の客数/売上は foodcourt_tenant_reports(LINE日報) 由来で、日報が投稿されない日が
--   丸ごと欠落していた（例: 2026-06-14(日)=236人、6/1〜6/5、6/24 など）。月次日別売上管理表
--   （analytics.html / /receipts/sales）は line_receipt__marugoS のレシート集計＋手入力上書き
--   (line_sales_manual_day) で全日そろっており、こちらが正本。来店人数はこのビューを採用する。
--
-- 突合確認: 日報がある日は日報＝レシートで完全一致（差0）。違いは「日報が無い日の欠落」と
--   「今後の手入力修正の反映」だけ。
--
-- 税基準（重要）: フードコート店舗別売上一覧（日報）は「税抜」、精算レシートは「税込」。両者そのまま運用する。
--   よってフードコート分析の売上は税抜＝レシートの net_sales_yen を採用（日報の税抜売上と全報告日で完全一致）。
--   税込(gross_sales_yen)は精算レシート基準の参考として sales_gross に併せて出す。
-- 手入力(line_sales_manual_day)は管理表の「総売上＝税込」入力のため、税抜分析の売上には適用しない（混在防止）。
--   客数・組数は税に依存しないので手入力があれば優先する（管理表＝来店人数の正本）。
-- 日付は receipt_date / sales_date（＝実売上日）。foodcourt分析の salesDate(=日報日-1) と整合する。
-- セキュリティ: security_invoker=true・service_role のみに付与（anon/authenticated 不可）。
-- ============================================================

-- 列構成を変えるため create or replace ではなく drop+create（再適用も安全）。
drop view if exists public.foodcourt_base_daily;
create view public.foodcourt_base_daily
with (security_invoker = true) as
with rcpt as (
  select receipt_date as d,
         sum(guest_count)::bigint     as guests,
         sum(net_sales_yen)::bigint   as net_sales,    -- 税抜（店舗別一覧と同基準・日報と一致）
         sum(gross_sales_yen)::bigint as gross_sales,  -- 税込（精算レシート基準・参考）
         sum(party_count)::bigint     as party
  from public."line_receipt__marugoS"
  where receipt_date is not null
  group by receipt_date
),
man as (
  select sales_date as d, guest_count, party_count
  from public.line_sales_manual_day
  where store_partition_key ilike 'marugoS'
)
select
  dd.d                                       as business_date,
  coalesce(man.guest_count, rcpt.guests)     as guests,
  rcpt.net_sales                             as sales,        -- 採用値＝税抜
  rcpt.gross_sales                           as sales_gross,  -- 参考＝税込
  coalesce(man.party_count, rcpt.party)      as party,
  (man.guest_count is not null or man.party_count is not null) as has_manual
from (select d from rcpt union select d from man) dd
left join rcpt on rcpt.d = dd.d
left join man  on man.d  = dd.d;

grant select on public.foodcourt_base_daily to service_role;
