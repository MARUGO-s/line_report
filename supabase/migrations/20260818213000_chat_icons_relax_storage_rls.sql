-- アイコン保存が RLS で弾かれていたため、chat-icons は
-- ログイン済みユーザーなら読み書きできるようにする。

drop policy if exists chat_icons_insert on storage.objects;
drop policy if exists chat_icons_update on storage.objects;
drop policy if exists chat_icons_delete on storage.objects;
drop policy if exists chat_icons_select on storage.objects;

create policy chat_icons_select on storage.objects
  for select to public
  using (bucket_id = 'chat-icons');

create policy chat_icons_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'chat-icons');

create policy chat_icons_update on storage.objects
  for update to authenticated
  using (bucket_id = 'chat-icons')
  with check (bucket_id = 'chat-icons');

create policy chat_icons_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'chat-icons');
