-- M-talk least-privilege cleanup.
--
-- Browser clients authenticate as `authenticated`. Anonymous visitors do not
-- need table or sequence privileges for any chat object. RLS already denied
-- anonymous rows, but removing the grants adds an independent deny layer.

do $cleanup$
declare
  item record;
begin
  for item in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname like 'chat\_%' escape '\'
      and c.relkind in ('r', 'p')
  loop
    execute format('revoke all privileges on table public.%I from anon', item.relname);
  end loop;

  for item in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname like 'chat\_%' escape '\'
      and c.relkind = 'S'
  loop
    execute format('revoke all privileges on sequence public.%I from anon', item.relname);
  end loop;
end
$cleanup$;

-- Trigger functions are invoked by PostgreSQL and must not be callable through
-- the Data API. Trigger execution does not depend on caller EXECUTE grants.
revoke all on function public.chat_prevent_direct_extra_member() from public, anon, authenticated;
revoke all on function public.chat_protect_admin_notice_room() from public, anon, authenticated;
revoke all on function public.chat_validate_album_item() from public, anon, authenticated;
grant execute on function public.chat_prevent_direct_extra_member() to service_role;
grant execute on function public.chat_protect_admin_notice_room() to service_role;
grant execute on function public.chat_validate_album_item() to service_role;

-- Pure UUID derivation does not read tables, but still pins name resolution so
-- a caller-controlled search_path cannot shadow built-in functions.
alter function public.chat_store_bot_id(text) set search_path = pg_catalog;

-- A stopped, temporarily restricted, or logically deleted M-talk account must
-- not keep a side door to personal chat data through direct Data API calls.
drop policy if exists chat_private_notes_select_own on public.chat_private_notes;
create policy chat_private_notes_select_own on public.chat_private_notes
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and public.chat_has_active_access()
  );

drop policy if exists chat_private_notes_delete_own on public.chat_private_notes;
create policy chat_private_notes_delete_own on public.chat_private_notes
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    and public.chat_has_active_access()
  );

drop policy if exists chat_keep_items_select_own on public.chat_keep_items;
create policy chat_keep_items_select_own on public.chat_keep_items
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and public.chat_has_active_access()
  );

drop policy if exists chat_keep_items_insert_own on public.chat_keep_items;
create policy chat_keep_items_insert_own on public.chat_keep_items
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and public.chat_has_active_access()
  );

drop policy if exists chat_keep_items_update_own on public.chat_keep_items;
create policy chat_keep_items_update_own on public.chat_keep_items
  for update to authenticated
  using (
    user_id = (select auth.uid())
    and public.chat_has_active_access()
  )
  with check (
    user_id = (select auth.uid())
    and public.chat_has_active_access()
  );

drop policy if exists chat_keep_items_delete_own on public.chat_keep_items;
create policy chat_keep_items_delete_own on public.chat_keep_items
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    and public.chat_has_active_access()
  );
