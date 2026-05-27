-- Store-scoped receipt search for LINE bot

-- レシート検索インデックス（店舗×日付）
create index if not exists line_room_receipt_search_receipt_table_receipt_date_idx
  on public.line_room_receipt_search (receipt_table, receipt_date desc nulls last);

-- receipt_table（店舗）を明示して 1年分検索する（room_id は任意）
create or replace function public.search_line_room_receipt_search_by_receipt_table(
  p_receipt_table text,
  p_room_id text default null,
  p_receipt_date date default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  id bigint,
  room_id text,
  receipt_date date,
  summary_text text,
  gross_sales_yen bigint,
  net_sales_yen bigint,
  line_message_id text,
  created_at timestamptz,
  total_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  lim int;
  off int;
  since timestamptz := now() - interval '365 days';
begin
  if coalesce(btrim(p_receipt_table), '') = '' then
    raise exception 'p_receipt_table is required';
  end if;
  if p_receipt_date is null then
    raise exception 'p_receipt_date is required';
  end if;

  lim := greatest(1, least(coalesce(p_limit, 50), 100));
  off := greatest(coalesce(p_offset, 0), 0);

  return query
  with filtered as (
    select r.*
    from public.line_room_receipt_search r
    where r.receipt_table = p_receipt_table
      and r.created_at >= since
      and r.receipt_date = p_receipt_date
      and (p_room_id is null or btrim(p_room_id) = '' or r.room_id = p_room_id)
  ),
  counted as (select count(*)::bigint as cnt from filtered)
  select
    f.id,
    f.room_id,
    f.receipt_date,
    f.summary_text,
    f.gross_sales_yen,
    f.net_sales_yen,
    f.line_message_id,
    f.created_at,
    c.cnt as total_count
  from filtered f
  cross join counted c
  order by f.created_at desc
  limit lim offset off;
end;
$$;

