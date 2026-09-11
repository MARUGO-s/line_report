-- SQL SUM ignores NULL, while the shared daily resolver marks an incomplete
-- receipt field unknown. Keep the forecast view on exactly the same boundary.
create or replace view public.foodcourt_base_daily with (security_invoker = true) as
with rcpt as (
  select receipt_date as d,
    case when bool_and(guest_count is not null and guest_count between 0 and 99999)
      then sum(guest_count)::bigint end as guests,
    case when bool_and(party_count is not null and party_count between 0 and 9999)
      then sum(party_count)::bigint end as party,
    case when bool_and(gross_sales_yen is not null and gross_sales_yen between 0 and 9007199254740991)
      then sum(gross_sales_yen)::bigint end as gross_sales,
    case when bool_and(tax_amount_yen is not null and tax_amount_yen between 0 and 9007199254740991)
      then sum(tax_amount_yen)::bigint end as tax,
    case when bool_and(net_sales_yen is not null and net_sales_yen between 0 and 9007199254740991)
      then sum(net_sales_yen)::bigint end as net_sales
  from public."line_receipt__marugoS" where receipt_date is not null group by receipt_date
), man as (
  select * from public.line_sales_manual_day where store_partition_key = 'marugoS'
)
select dd.d as business_date,
  coalesce(man.guest_count, rcpt.guests, 0::bigint) as guests,
  case when man.gross_sales_yen is not null or man.tax_amount_yen is not null then
    case when coalesce(man.tax_amount_yen, rcpt.tax) is null then null::bigint
      else greatest(0::bigint, coalesce(man.gross_sales_yen, rcpt.gross_sales, 0::bigint)
        - coalesce(man.tax_amount_yen, rcpt.tax)) end
    else rcpt.net_sales end as sales,
  coalesce(man.gross_sales_yen, rcpt.gross_sales, 0::bigint) as sales_gross,
  coalesce(man.party_count, rcpt.party, 0::bigint) as party,
  (man.gross_sales_yen is not null or man.guest_count is not null or man.party_count is not null) as has_manual
from (select d from rcpt union select sales_date from man) dd
left join rcpt on rcpt.d = dd.d left join man on man.sales_date = dd.d;
revoke all on public.foodcourt_base_daily from public, anon, authenticated;
grant select on public.foodcourt_base_daily to service_role;
