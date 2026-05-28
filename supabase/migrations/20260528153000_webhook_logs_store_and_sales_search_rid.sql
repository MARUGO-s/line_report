-- 売上検索 RPC に receipt_row_id を返す / Webhook 送信ログに店舗キーを追加

alter table public.line_webhook_delivery_logs
  add column if not exists store_partition_key text;

create index if not exists line_webhook_delivery_logs_store_id_idx
  on public.line_webhook_delivery_logs (store_partition_key, id desc);

drop function if exists public.search_line_room_receipt_search_by_receipt_table(text, text, date, integer, integer);

create function public.search_line_room_receipt_search_by_receipt_table(
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
  receipt_date_text text,
  store_name text,
  tax_amount_yen bigint,
  party_count bigint,
  guest_count bigint,
  unit_price_yen bigint,
  summary_text text,
  gross_sales_yen bigint,
  net_sales_yen bigint,
  line_message_id text,
  receipt_row_id bigint,
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
    f.receipt_date_text,
    f.store_name,
    f.tax_amount_yen,
    f.party_count,
    f.guest_count,
    f.unit_price_yen,
    f.summary_text,
    f.gross_sales_yen,
    f.net_sales_yen,
    f.line_message_id,
    f.receipt_row_id,
    f.created_at,
    c.cnt as total_count
  from filtered f
  cross join counted c
  order by f.created_at desc
  limit lim offset off;
end;
$$;
