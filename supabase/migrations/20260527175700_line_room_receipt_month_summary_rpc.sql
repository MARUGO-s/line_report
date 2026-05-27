-- Month summary RPC for store-scoped receipt table
-- 6桁（YYYYMM）の売上検索用: 月次の合計金額・人数・組数を返す

drop function if exists public.search_line_room_receipt_month_summary_by_receipt_table(text, text, date, date);

create function public.search_line_room_receipt_month_summary_by_receipt_table(
  p_receipt_table text,
  p_room_id text,
  p_from_date date,
  p_to_date_exclusive date
)
returns table (
  total_gross_sales_yen bigint,
  total_net_sales_yen bigint,
  total_tax_amount_yen bigint,
  total_party_count bigint,
  total_guest_count bigint,
  receipt_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  sql text;
begin
  if coalesce(btrim(p_receipt_table), '') = '' then
    raise exception 'p_receipt_table is required';
  end if;
  if p_from_date is null or p_to_date_exclusive is null then
    raise exception 'p_from_date and p_to_date_exclusive are required';
  end if;
  if p_to_date_exclusive <= p_from_date then
    raise exception 'invalid date range: % .. %', p_from_date, p_to_date_exclusive;
  end if;

  -- Dynamic query against store receipt table.
  sql := format($fmt$
    select
      coalesce(sum(r.gross_sales_yen), 0)::bigint as total_gross_sales_yen,
      coalesce(sum(r.net_sales_yen), 0)::bigint as total_net_sales_yen,
      coalesce(sum(r.tax_amount_yen), 0)::bigint as total_tax_amount_yen,
      coalesce(sum(r.party_count), 0)::bigint as total_party_count,
      coalesce(sum(r.guest_count), 0)::bigint as total_guest_count,
      count(*)::bigint as receipt_count
    from %I r
    where r.receipt_date >= $1
      and r.receipt_date < $2
      and ($3 is null or btrim($3) = '' or r.room_id = $3)
  $fmt$, btrim(p_receipt_table));

  return query execute sql using p_from_date, p_to_date_exclusive, p_room_id;
end;
$$;

