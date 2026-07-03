-- 「過去の予約」表示だけは partner をまたいで参照する。
-- 予約回数(visit_count)は既存どおり partner ごとのままにしつつ、
-- recent_visits は氏名+電話で全 partner(tabelog/ikyu/manual) を横断して返す。

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
        'store_name', store_name,
        'partner', partner
      )
      order by visit_at desc
    ),
    '[]'::jsonb
  )
  from (
    select
      h.partner,
      h.visit_at,
      h.is_cancelled,
      public.reservation_visit_store_name(h.reservation_detail) as store_name
    from public.reservation_customer_visit_history h
    where h.customer_name = p_customer_name
      and h.customer_phone = p_customer_phone
      and (
        p_exclude_gmail_message_id is null
        or h.gmail_message_id <> p_exclude_gmail_message_id
      )
    order by h.visit_at desc
    limit greatest(1, least(coalesce(p_limit, 5), 5))
  ) recent;
$$;
