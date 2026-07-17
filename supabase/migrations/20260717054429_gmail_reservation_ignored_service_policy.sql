create policy "Service role manages ignored reservation messages"
on public.gmail_reservation_ignored_messages
for all
to service_role
using (true)
with check (true);
