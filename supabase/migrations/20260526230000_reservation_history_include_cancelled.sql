-- LINE 予約通知: 過去履歴にキャンセル分も含める（最大5件・is_cancelled 付き）

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
        'is_cancelled', is_cancelled
      )
      order by visit_at desc
    ),
    '[]'::jsonb
  )
  from (
    select h.visit_at, h.is_cancelled
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

create or replace function public.record_partner_reservation_visit(
  p_partner text,
  p_event_table regclass,
  p_summary_table regclass,
  p_gmail_message_id text,
  p_customer_name text,
  p_customer_phone text,
  p_visit_at timestamptz default null,
  p_reservation_type text default null,
  p_reservation_detail text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_phone text;
  v_visit_at timestamptz;
  v_cancelled boolean;
  v_row_count integer;
  v_visit_count integer;
  v_cancelled_count integer;
  v_recent jsonb;
  v_type text;
  v_detail text;
  v_sql text;
begin
  if nullif(trim(p_gmail_message_id), '') is null then
    return null;
  end if;
  if p_partner not in ('tabelog', 'ikyu') then
    return null;
  end if;

  v_name := nullif(trim(p_customer_name), '');
  v_phone := nullif(trim(p_customer_phone), '');
  if v_name is null or v_phone is null then
    return null;
  end if;

  v_visit_at := coalesce(p_visit_at, now());
  v_type := nullif(trim(coalesce(p_reservation_type, '')), '');
  v_detail := nullif(trim(coalesce(p_reservation_detail, '')), '');
  v_cancelled := public.reservation_visit_looks_cancelled(v_type, v_detail);

  v_sql := format(
    $f$
    insert into %s (
      gmail_message_id, customer_name, customer_phone, visit_at, reservation_type, reservation_detail
    ) values ($1, $2, $3, $4, $5, $6)
    on conflict (gmail_message_id) do nothing
    $f$,
    p_event_table::text
  );
  execute v_sql using p_gmail_message_id, v_name, v_phone, v_visit_at, v_type, v_detail;
  get diagnostics v_row_count = row_count;

  insert into public.reservation_customer_visit_history (
    partner, gmail_message_id, customer_name, customer_phone,
    visit_at, reservation_type, reservation_detail, is_cancelled
  ) values (
    p_partner, p_gmail_message_id, v_name, v_phone,
    v_visit_at, v_type, v_detail, v_cancelled
  )
  on conflict (partner, gmail_message_id) do nothing;

  if v_row_count > 0 then
    if v_cancelled then
      v_sql := format(
        $f$
        insert into %s (customer_name, customer_phone, visit_count, last_visit_at, created_at, updated_at)
        values ($1, $2, 0, null, now(), now())
        on conflict (customer_name, customer_phone) do update
          set visit_count = greatest(0, %s.visit_count - 1),
              updated_at = now()
        $f$,
        p_summary_table::text,
        p_summary_table::text
      );
      execute v_sql using v_name, v_phone;
    else
      v_sql := format(
        $f$
        insert into %s (customer_name, customer_phone, visit_count, last_visit_at, created_at, updated_at)
        values ($1, $2, 1, $3, now(), now())
        on conflict (customer_name, customer_phone) do update
          set visit_count = %s.visit_count + 1,
              last_visit_at = greatest(
                coalesce(%s.last_visit_at, excluded.last_visit_at),
                excluded.last_visit_at
              ),
              updated_at = now()
        $f$,
        p_summary_table::text,
        p_summary_table::text,
        p_summary_table::text
      );
      execute v_sql using v_name, v_phone, v_visit_at;
    end if;
  end if;

  v_sql := format(
    'select visit_count from %s where customer_name = $1 and customer_phone = $2 limit 1',
    p_summary_table::text
  );
  execute v_sql into v_visit_count using v_name, v_phone;
  v_visit_count := coalesce(v_visit_count, 0);

  select count(*)::integer
    into v_cancelled_count
  from public.reservation_customer_visit_history h
  where h.partner = p_partner
    and h.customer_name = v_name
    and h.customer_phone = v_phone
    and h.is_cancelled = true;

  v_recent := public.get_reservation_recent_visits_json(
    p_partner, v_name, v_phone, p_gmail_message_id, 5
  );

  return jsonb_build_object(
    'visit_count', v_visit_count,
    'cancelled_count', coalesce(v_cancelled_count, 0),
    'recent_visits', v_recent
  );
end;
$$;
