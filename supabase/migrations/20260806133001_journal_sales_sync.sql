-- ジャーナル→過去売上の自動同期のための出所（provenance）記録・税額列・店舗フラグ。
--
-- 背景: line_sales_manual_day / line_sales_manual_month_gross には
--   (1) ジャーナル（POS電子ジャーナル）由来
--   (2) LINEレシート由来（_shared/store_receipt.ts など）
--   (3) 人手入力（予算入力フロー等）
-- の3経路から書き込まれるが、どの経路で入った値かを区別する列がなかった。
-- ジャーナルを正として自動上書きする以上、上書きされた行を後から識別できる必要がある。

alter table public.line_sales_manual_day
  add column if not exists source text;

alter table public.line_sales_manual_month_gross
  add column if not exists source text;

comment on column public.line_sales_manual_day.source is
  '値の出所。journal=POS電子ジャーナル由来（自動同期）、receipt=LINEレシート由来、manual=人手入力。null は出所不明（この列の追加前に入った行）。';

comment on column public.line_sales_manual_month_gross.source is
  '値の出所。journal=POS電子ジャーナル由来（自動同期）、receipt=LINEレシート由来、manual=人手入力。null は出所不明（この列の追加前に入った行）。';

-- 月次の税抜/税額は「日次の合計」から再計算する設計にする。
-- 部分月のアップロードで完全な月が上書きされる事故を構造的に防ぐため、
-- 月次は常に line_sales_manual_day 全体を集計して作る。
-- そのためには日次側に税額が必要だが、これまで列が無かったので追加する。
alter table public.line_sales_manual_day
  add column if not exists tax_amount_yen bigint;

comment on column public.line_sales_manual_day.tax_amount_yen is
  '当日の消費税額。月次の tax_amount_yen / net_sales_yen はこの列の合計から再計算する。';

-- 既存のジャーナル由来行へ税額を補完する。
-- 出所は saved_reports（日別売上レポート）の会計明細。合算レポートは重複するため除外。
with rep as (
  select id, created_at, data->'sales' as sales
    from public.saved_reports
   where deleted_at is null
     and title like '日別売上レポート%'
     and title not like '合算%'
     and jsonb_typeof(data->'sales') = 'array'
     and store_partition_key = 'bistrocavacava'
), rws as (
  select r.id,
         r.created_at,
         (s->>'date')::date            as d,
         coalesce((s->>'tax')::numeric, 0) as tax
    from rep r, jsonb_array_elements(r.sales) s
   where s->>'date' is not null
), per_report as (
  select id, created_at, d, sum(tax) as t
    from rws
   group by id, created_at, d
), pick as (
  -- 同じ日が複数レポートに含まれる場合は最新レポートを採用（再アップロードでも値は同一）
  select distinct on (d) d, t
    from per_report
   order by d, created_at desc
)
update public.line_sales_manual_day x
   set tax_amount_yen = pick.t::bigint
  from pick
 where x.store_partition_key = 'bistrocavacava'
   and x.sales_date = pick.d
   and x.tax_amount_yen is null;

-- 既存行のうち、ジャーナルから遡って投入したことが確認できている店舗のみ journal を立てる。
-- 他店舗は出所が判別できないため null のまま残す（誤ったラベルを付けない）。
update public.line_sales_manual_day
   set source = 'journal'
 where store_partition_key = 'bistrocavacava'
   and source is null;

update public.line_sales_manual_month_gross
   set source = 'journal'
 where store_partition_key = 'bistrocavacava'
   and source is null;

-- 店舗ごとの同期ON/OFF。既定はOFF（プロフィール未設定＝無効）。
-- 有効化する場合:
--   update public.store_operation_profiles
--      set profile = profile || '{"journalSalesSync": true}'::jsonb
--    where store_partition_key = '<store>';
comment on table public.store_operation_profiles is
  'Journal Report 店舗営業情報（定休・ランチ等）。profile.journalSalesSync=true でジャーナル→過去売上の自動同期を有効化。店舗分離は store_partition_key。admin-api 経由のみ。';
