-- チャットのユーザー／グループアイコン。
-- 画像は Storage の公開バケット chat-icons に置き、URL を各テーブルへ保存する。

alter table public.chat_users
  add column if not exists icon_url text;

alter table public.chat_groups
  add column if not exists icon_url text;

drop policy if exists chat_users_update_self on public.chat_users;
create policy chat_users_update_self on public.chat_users
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists chat_groups_update_member on public.chat_groups;
create policy chat_groups_update_member on public.chat_groups
  for update to authenticated
  using (public.chat_is_member(id))
  with check (public.chat_is_member(id));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-icons',
  'chat-icons',
  true,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists chat_icons_insert on storage.objects;
create policy chat_icons_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'chat-icons'
    and (
      (
        (storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = auth.uid()::text
      )
      or (
        (storage.foldername(name))[1] = 'groups'
        and public.chat_is_member(((storage.foldername(name))[2])::bigint)
      )
    )
  );

drop policy if exists chat_icons_update on storage.objects;
create policy chat_icons_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'chat-icons'
    and (
      (
        (storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = auth.uid()::text
      )
      or (
        (storage.foldername(name))[1] = 'groups'
        and public.chat_is_member(((storage.foldername(name))[2])::bigint)
      )
    )
  )
  with check (
    bucket_id = 'chat-icons'
    and (
      (
        (storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = auth.uid()::text
      )
      or (
        (storage.foldername(name))[1] = 'groups'
        and public.chat_is_member(((storage.foldername(name))[2])::bigint)
      )
    )
  );

drop policy if exists chat_icons_delete on storage.objects;
create policy chat_icons_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'chat-icons'
    and (
      (
        (storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = auth.uid()::text
      )
      or (
        (storage.foldername(name))[1] = 'groups'
        and public.chat_is_member(((storage.foldername(name))[2])::bigint)
      )
    )
  );
