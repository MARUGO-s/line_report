-- 予約履歴の recent_visits に店舗名を含める。
-- 氏名+電話の履歴集計はそのまま維持しつつ、他店舗の来店履歴だけ LINE 通知上で判別できるようにする。

create or replace function public.reservation_visit_store_name(
  p_reservation_detail text
)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_detail text := coalesce(trim(p_reservation_detail), '');
  v_parsed jsonb;
begin
  if v_detail = '' then
    return null;
  end if;

  if v_detail like '{%' then
    begin
      v_parsed := v_detail::jsonb;
      return nullif(trim(coalesce(v_parsed ->> 'storeName', '')), '');
    exception when others then
      return null;
    end;
  end if;

  return null;
end;
$$;

create or replace function public.get_reservation_recent_visits_json(
  p_partner text,
  p_customer_name text,
  p_customer_phone text,
  p_exclude_gmail_message_id text default null,
  p_limit integer default 5
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'visit_at', visit_at,
        'is_cancelled', is_cancelled,
        'store_name', store_name
      )
      order by visit_at desc
    ),
    '[]'::jsonb
  )
  from (
    select
      h.visit_at,
      h.is_cancelled,
      public.reservation_visit_store_name(h.reservation_detail) as store_name
    from public.reservation_customer_visit_history h
    where h.partner = p_partner
      and h.customer_name = p_customer_name
      and h.customer_phone = p_customer_phone
      and (
        p_exclude_gmail_message_id is null
        or h.gmail_message_id <> p_exclude_gmail_message_id
      )
    order by h.visit_at desc
    limit greatest(1, least(coalesce(p_limit, 5), 5))
  ) recent;
$$;
