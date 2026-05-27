-- line_room_receipt_search にレシート返信と同じ項目を載せる

alter table public.line_room_receipt_search
  add column if not exists store_name text,
  add column if not exists receipt_date_text text,
  add column if not exists tax_amount_yen bigint,
  add column if not exists party_count bigint,
  add column if not exists guest_count bigint,
  add column if not exists unit_price_yen bigint;

-- upsert: 既存コールがあるため新パラメータはデフォルト付き
create or replace function public.upsert_line_room_receipt_search(
  p_room_id text,
  p_store_partition_key text default null,
  p_line_message_id text default null,
  p_receipt_date date default null,
  p_summary_text text default '',
  p_gross_sales_yen bigint default null,
  p_net_sales_yen bigint default null,
  p_tax_amount_yen bigint default null,
  p_party_count bigint default null,
  p_guest_count bigint default null,
  p_unit_price_yen bigint default null,
  p_store_name text default null,
  p_receipt_date_text text default null,
  p_receipt_table text default '',
  p_receipt_row_id bigint default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  row_id bigint;
begin
  if not public.is_valid_line_room_id(p_room_id) then
    raise exception 'invalid room_id: %', p_room_id;
  end if;

  if coalesce(btrim(p_receipt_table), '') = '' or p_receipt_row_id is null then
    return null;
  end if;

  insert into public.line_room_receipt_search (
    room_id,
    store_partition_key,
    line_message_id,
    receipt_date,
    receipt_date_text,
    store_name,
    summary_text,
    gross_sales_yen,
    net_sales_yen,
    tax_amount_yen,
    party_count,
    guest_count,
    unit_price_yen,
    receipt_table,
    receipt_row_id
  ) values (
    p_room_id,
    nullif(btrim(p_store_partition_key), ''),
    nullif(btrim(p_line_message_id), ''),
    p_receipt_date,
    nullif(btrim(p_receipt_date_text), ''),
    nullif(btrim(p_store_name), ''),
    coalesce(btrim(p_summary_text), ''),
    p_gross_sales_yen,
    p_net_sales_yen,
    p_tax_amount_yen,
    p_party_count,
    p_guest_count,
    p_unit_price_yen,
    btrim(p_receipt_table),
    p_receipt_row_id
  )
  on conflict (receipt_table, receipt_row_id)
  do update set
    summary_text = excluded.summary_text,
    gross_sales_yen = excluded.gross_sales_yen,
    net_sales_yen = excluded.net_sales_yen,
    receipt_date = excluded.receipt_date,
    line_message_id = excluded.line_message_id,
    tax_amount_yen = excluded.tax_amount_yen,
    party_count = excluded.party_count,
    guest_count = excluded.guest_count,
    unit_price_yen = excluded.unit_price_yen,
    store_name = excluded.store_name,
    receipt_date_text = excluded.receipt_date_text
  returning id into row_id;
  return row_id;
end;
$$;

-- Store scoped search RPC（レシート項目付き）
-- Note: 既存関数の return type を create or replace で変更できないため drop して作り直します
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
    f.created_at,
    c.cnt as total_count
  from filtered f
  cross join counted c
  order by f.created_at desc
  limit lim offset off;
end;
$$;

