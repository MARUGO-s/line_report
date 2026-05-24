create or replace function public.aggregate_store_receipt_monthly_sales(
  p_store_partition_key text,
  p_from_date date default null
)
returns table (
  sales_month text,
  gross_sales_yen bigint,
  party_count integer,
  guest_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_receipt_table text;
  v_from_date date := coalesce(p_from_date, date '1970-01-01');
begin
  select swt.receipt_table
    into v_receipt_table
  from public.store_webhook_tables swt
  where lower(swt.store_partition_key) = lower(coalesce(btrim(p_store_partition_key), ''))
  order by swt.store_partition_key
  limit 1;

  if v_receipt_table is null then
    return;
  end if;

  return query execute format($sql$
    select
      to_char(receipt_date, 'YYYY-MM')::text as sales_month,
      sum(gross_sales_yen)::bigint as gross_sales_yen,
      sum(greatest(coalesce(party_count, 0), 0))::integer as party_count,
      sum(greatest(coalesce(guest_count, 0), 0))::integer as guest_count
    from public.%I
    where receipt_date is not null
      and gross_sales_yen is not null
      and gross_sales_yen > 0
      and receipt_date >= %L::date
    group by 1
    order by 1
  $sql$, v_receipt_table, v_from_date);
end;
$$;

comment on function public.aggregate_store_receipt_monthly_sales(text, date) is
  '店舗別 line_receipt__* を月単位で集計して返す。receipt-sheets の過去売上補完用。';
