-- Allow album creators to edit their own album; room managers retain full control.
drop policy if exists chat_albums_delete_manager on public.chat_albums;
create policy chat_albums_delete_owner_or_manager on public.chat_albums
  for delete to authenticated using (
    created_by = (select auth.uid()) or public.chat_can_manage_group(group_id)
  );

drop policy if exists chat_album_items_delete_manager on public.chat_album_items;
create policy chat_album_items_delete_album_owner_or_manager on public.chat_album_items
  for delete to authenticated using (
    public.chat_can_manage_group(group_id)
    or exists (
      select 1 from public.chat_albums a
      where a.id = chat_album_items.album_id
        and a.created_by = (select auth.uid())
    )
  );
