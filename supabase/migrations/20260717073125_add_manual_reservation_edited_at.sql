-- Image-imported reservations write this audit timestamp when an existing
-- manual reservation is overwritten from the LINE confirmation card.
alter table public.manual_reservation_visit_events
  add column if not exists manual_edited_at timestamptz;

update public.manual_reservation_visit_events
   set manual_edited_at = updated_at
 where manual_edited_at is null
   and updated_at is distinct from created_at;
