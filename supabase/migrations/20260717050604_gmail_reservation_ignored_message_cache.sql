-- Cache Gmail messages that were inspected and determined not to be a
-- supported reservation notification. Without this cache, the same ignored
-- messages occupy the per-run processing limit every minute and can block
-- older valid reservations.

create table if not exists public.gmail_reservation_ignored_messages (
  gmail_message_id text primary key,
  gmail_thread_id text,
  gmail_subject text,
  gmail_from text,
  gmail_internal_date timestamptz,
  ignore_reason text not null check (
    ignore_reason in ('unsupported_route', 'non_reservation_notification')
  ),
  created_at timestamptz not null default now()
);

create index if not exists gmail_reservation_ignored_messages_created_at_idx
  on public.gmail_reservation_ignored_messages (created_at desc);

alter table public.gmail_reservation_ignored_messages enable row level security;
revoke all on table public.gmail_reservation_ignored_messages from anon, authenticated;

comment on table public.gmail_reservation_ignored_messages is
  'Gmail reservation scanner cache for inspected non-reservation messages; retained for 30 days.';
