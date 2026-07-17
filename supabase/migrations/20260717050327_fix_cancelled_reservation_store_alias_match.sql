-- Reservation emails can spell the same store differently (for example,
-- "BISTRO CAVA CAVA" and "ビストロ サヴァサヴァ"). For cancellation
-- messages without a reservation number, use a unique exact customer/phone/
-- visit-time match instead of requiring raw store-name equality.

create or replace function public.hide_cancelled_partner_reservation_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table text := format('%I.%I', tg_table_schema, tg_table_name);
  v_reservation_no text;
  v_candidate_count integer := 0;
  v_candidate_id bigint;
begin
  if not public.reservation_visit_looks_cancelled(
    new.reservation_type,
    new.reservation_detail
  ) then
    return new;
  end if;

  new.manual_hidden := true;
  new.manual_hidden_reason := 'cancel';
  new.manual_edited_at := now();

  v_reservation_no := public.reservation_visit_extract_reservation_no(
    new.reservation_detail
  );

  if v_reservation_no is not null then
    execute format(
      $sql$
        update %s e
           set manual_hidden = true,
               manual_hidden_reason = 'cancel',
               manual_edited_at = now()
         where e.id <> $1
           and e.customer_name = $2
           and e.customer_phone = $3
           and coalesce(e.manual_hidden, false) = false
           and not public.reservation_visit_looks_cancelled(
             e.reservation_type,
             e.reservation_detail
           )
           and public.reservation_visit_extract_reservation_no(
             e.reservation_detail
           ) = $4
      $sql$,
      v_table
    ) using new.id, new.customer_name, new.customer_phone, v_reservation_no;
    return new;
  end if;

  execute format(
    $sql$
      select count(*)::integer, min(e.id)
        from %s e
       where e.id <> $1
         and e.customer_name = $2
         and e.customer_phone = $3
         and e.visit_at = $4
         and coalesce(e.manual_hidden, false) = false
         and not public.reservation_visit_looks_cancelled(
           e.reservation_type,
           e.reservation_detail
         )
    $sql$,
    v_table
  ) into v_candidate_count, v_candidate_id
    using new.id, new.customer_name, new.customer_phone, new.visit_at;

  if v_candidate_count = 1 and v_candidate_id is not null then
    execute format(
      $sql$
        update %s
           set manual_hidden = true,
               manual_hidden_reason = 'cancel',
               manual_edited_at = now()
         where id = $1
      $sql$,
      v_table
    ) using v_candidate_id;
  end if;

  return new;
end;
$$;

with cancellation_matches as (
  select c.id cancellation_id, min(a.id) active_id
  from public.tabelog_reservation_visit_events c
  join public.tabelog_reservation_visit_events a
    on a.id <> c.id
   and a.customer_name = c.customer_name
   and a.customer_phone = c.customer_phone
   and a.visit_at = c.visit_at
   and coalesce(a.manual_hidden, false) = false
   and not public.reservation_visit_looks_cancelled(a.reservation_type, a.reservation_detail)
  where public.reservation_visit_looks_cancelled(c.reservation_type, c.reservation_detail)
    and public.reservation_visit_extract_reservation_no(c.reservation_detail) is null
  group by c.id
  having count(*) = 1
)
update public.tabelog_reservation_visit_events active
   set manual_hidden = true,
       manual_hidden_reason = 'cancel',
       manual_edited_at = now()
  from cancellation_matches
 where active.id = cancellation_matches.active_id;

with cancellation_matches as (
  select c.id cancellation_id, min(a.id) active_id
  from public.ikyu_reservation_visit_events c
  join public.ikyu_reservation_visit_events a
    on a.id <> c.id
   and a.customer_name = c.customer_name
   and a.customer_phone = c.customer_phone
   and a.visit_at = c.visit_at
   and coalesce(a.manual_hidden, false) = false
   and not public.reservation_visit_looks_cancelled(a.reservation_type, a.reservation_detail)
  where public.reservation_visit_looks_cancelled(c.reservation_type, c.reservation_detail)
    and public.reservation_visit_extract_reservation_no(c.reservation_detail) is null
  group by c.id
  having count(*) = 1
)
update public.ikyu_reservation_visit_events active
   set manual_hidden = true,
       manual_hidden_reason = 'cancel',
       manual_edited_at = now()
  from cancellation_matches
 where active.id = cancellation_matches.active_id;
