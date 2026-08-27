-- Keep/private-note policies must use an authenticated-callable access gate.
--
-- `chat_has_active_access(uuid)` is intentionally service_role-only because it
-- can inspect arbitrary users. `chat_is_registered()` is the reviewed
-- authenticated wrapper: it fixes the subject to auth.uid() and includes the
-- same stopped/restricted/deleted checks internally.

drop policy if exists chat_private_notes_select_own on public.chat_private_notes;
create policy chat_private_notes_select_own on public.chat_private_notes
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and public.chat_is_registered()
  );

drop policy if exists chat_private_notes_delete_own on public.chat_private_notes;
create policy chat_private_notes_delete_own on public.chat_private_notes
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    and public.chat_is_registered()
  );

drop policy if exists chat_keep_items_select_own on public.chat_keep_items;
create policy chat_keep_items_select_own on public.chat_keep_items
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and public.chat_is_registered()
  );

drop policy if exists chat_keep_items_insert_own on public.chat_keep_items;
create policy chat_keep_items_insert_own on public.chat_keep_items
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and public.chat_is_registered()
  );

drop policy if exists chat_keep_items_update_own on public.chat_keep_items;
create policy chat_keep_items_update_own on public.chat_keep_items
  for update to authenticated
  using (
    user_id = (select auth.uid())
    and public.chat_is_registered()
  )
  with check (
    user_id = (select auth.uid())
    and public.chat_is_registered()
  );

drop policy if exists chat_keep_items_delete_own on public.chat_keep_items;
create policy chat_keep_items_delete_own on public.chat_keep_items
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    and public.chat_is_registered()
  );
