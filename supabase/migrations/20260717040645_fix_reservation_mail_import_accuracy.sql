-- Reservation email accuracy fixes:
-- 1. A cancellation must hide both the cancellation record and its active event.
-- 2. Repair the confirmed 2026-07-10 reservation that was inferred as 2028.

create or replace function public.hide_cancelled_partner_reservation_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table text := format('%I.%I', tg_table_schema, tg_table_name);
  v_reservation_no text;
  v_store_name text;
  v_candidate_count integer := 0;
  v_candidate_id bigint;
begin
  if not public.reservation_visit_looks_cancelled(
    new.reservation_type,
    new.reservation_detail
  ) then
    return new;
  end if;

  -- Keep the cancellation as history, but do not display it as an active booking.
  new.manual_hidden := true;
  new.manual_hidden_reason := 'cancel';
  new.manual_edited_at := now();

  v_reservation_no := public.reservation_visit_extract_reservation_no(
    new.reservation_detail
  );
  v_store_name := public.reservation_visit_store_name(new.reservation_detail);

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

  -- Older messages may not contain a reservation number. Only hide an active
  -- event when customer, phone, visit time and (when available) store identify
  -- exactly one candidate.
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
         and (
           $5 is null
           or public.reservation_visit_store_name(e.reservation_detail) = $5
         )
    $sql$,
    v_table
  ) into v_candidate_count, v_candidate_id
    using new.id, new.customer_name, new.customer_phone, new.visit_at, v_store_name;

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

drop trigger if exists tabelog_hide_cancelled_reservation_event
  on public.tabelog_reservation_visit_events;
create trigger tabelog_hide_cancelled_reservation_event
before insert on public.tabelog_reservation_visit_events
for each row execute function public.hide_cancelled_partner_reservation_events();

drop trigger if exists ikyu_hide_cancelled_reservation_event
  on public.ikyu_reservation_visit_events;
create trigger ikyu_hide_cancelled_reservation_event
before insert on public.ikyu_reservation_visit_events
for each row execute function public.hide_cancelled_partner_reservation_events();

-- Existing cancellation records must not appear as active reservations.
update public.tabelog_reservation_visit_events
   set manual_hidden = true,
       manual_hidden_reason = 'cancel',
       manual_edited_at = now()
 where public.reservation_visit_looks_cancelled(
   reservation_type,
   reservation_detail
 );

update public.ikyu_reservation_visit_events
   set manual_hidden = true,
       manual_hidden_reason = 'cancel',
       manual_edited_at = now()
 where public.reservation_visit_looks_cancelled(
   reservation_type,
   reservation_detail
 );

-- Hide active counterparts identified by reservation number.
with cancelled as (
  select customer_name, customer_phone,
         public.reservation_visit_extract_reservation_no(reservation_detail) reservation_no
  from public.tabelog_reservation_visit_events
  where public.reservation_visit_looks_cancelled(reservation_type, reservation_detail)
    and public.reservation_visit_extract_reservation_no(reservation_detail) is not null
)
update public.tabelog_reservation_visit_events active
   set manual_hidden = true,
       manual_hidden_reason = 'cancel',
       manual_edited_at = now()
  from cancelled
 where active.customer_name = cancelled.customer_name
   and active.customer_phone = cancelled.customer_phone
   and public.reservation_visit_extract_reservation_no(active.reservation_detail) = cancelled.reservation_no
   and not public.reservation_visit_looks_cancelled(active.reservation_type, active.reservation_detail);

with cancelled as (
  select customer_name, customer_phone,
         public.reservation_visit_extract_reservation_no(reservation_detail) reservation_no
  from public.ikyu_reservation_visit_events
  where public.reservation_visit_looks_cancelled(reservation_type, reservation_detail)
    and public.reservation_visit_extract_reservation_no(reservation_detail) is not null
)
update public.ikyu_reservation_visit_events active
   set manual_hidden = true,
       manual_hidden_reason = 'cancel',
       manual_edited_at = now()
  from cancelled
 where active.customer_name = cancelled.customer_name
   and active.customer_phone = cancelled.customer_phone
   and public.reservation_visit_extract_reservation_no(active.reservation_detail) = cancelled.reservation_no
   and not public.reservation_visit_looks_cancelled(active.reservation_type, active.reservation_detail);

-- For legacy records without a reservation number, hide only a unique exact
-- customer/phone/visit/store match.
with cancellation_matches as (
  select c.id cancellation_id, min(a.id) active_id
  from public.tabelog_reservation_visit_events c
  join public.tabelog_reservation_visit_events a
    on a.id <> c.id
   and a.customer_name = c.customer_name
   and a.customer_phone = c.customer_phone
   and a.visit_at = c.visit_at
   and not public.reservation_visit_looks_cancelled(a.reservation_type, a.reservation_detail)
   and (
     public.reservation_visit_store_name(c.reservation_detail) is null
     or public.reservation_visit_store_name(a.reservation_detail) =
        public.reservation_visit_store_name(c.reservation_detail)
   )
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
   and not public.reservation_visit_looks_cancelled(a.reservation_type, a.reservation_detail)
   and (
     public.reservation_visit_store_name(c.reservation_detail) is null
     or public.reservation_visit_store_name(a.reservation_detail) =
        public.reservation_visit_store_name(c.reservation_detail)
   )
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

-- Confirmed production repair: unrelated "2028" text in the email body was
-- used as the year for a 2026-07-10 reservation (reservation no. 65486673).
update public.tabelog_reservation_visit_events
   set visit_at = visit_at - interval '2 years',
       reservation_detail = jsonb_set(
         reservation_detail::jsonb,
         '{visitDateTime}',
         to_jsonb(regexp_replace(
           reservation_detail::jsonb ->> 'visitDateTime',
           '^2028',
           '2026'
         ))
       )::text
 where public.reservation_visit_extract_reservation_no(reservation_detail) = '65486673'
   and visit_at >= timestamptz '2028-01-01 00:00:00+00'
   and visit_at < timestamptz '2029-01-01 00:00:00+00';

update public.reservation_customer_visit_history
   set visit_at = visit_at - interval '2 years',
       reservation_detail = jsonb_set(
         reservation_detail::jsonb,
         '{visitDateTime}',
         to_jsonb(regexp_replace(
           reservation_detail::jsonb ->> 'visitDateTime',
           '^2028',
           '2026'
         ))
       )::text
 where partner = 'tabelog'
   and public.reservation_visit_extract_reservation_no(reservation_detail) = '65486673'
   and visit_at >= timestamptz '2028-01-01 00:00:00+00'
   and visit_at < timestamptz '2029-01-01 00:00:00+00';

do $$
declare
  customer record;
begin
  for customer in
    select distinct customer_name, customer_phone
    from public.reservation_customer_visit_history
    where partner = 'tabelog'
      and public.reservation_visit_extract_reservation_no(reservation_detail) = '65486673'
  loop
    perform public.rebuild_partner_reservation_summary(
      'tabelog',
      customer.customer_name,
      customer.customer_phone
    );
  end loop;
end;
$$;
