-- M-talk: LINE風のKeepメモ（個人）とアルバム（ルーム共有）。

create table if not exists public.chat_keep_items (
  id bigint primary key generated always as identity,
  user_id uuid not null references public.chat_users(id) on delete cascade,
  kind text not null default 'text',
  content text,
  payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_keep_items_kind_check check (kind in ('text', 'image', 'file')),
  constraint chat_keep_items_content_check check (
    nullif(btrim(coalesce(content, '')), '') is not null or payload is not null
  ),
  constraint chat_keep_items_content_length check (content is null or char_length(content) <= 5000)
);

create index if not exists idx_chat_keep_items_user_created
  on public.chat_keep_items (user_id, created_at desc);

alter table public.chat_keep_items enable row level security;
drop policy if exists chat_keep_items_select_own on public.chat_keep_items;
create policy chat_keep_items_select_own on public.chat_keep_items
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists chat_keep_items_insert_own on public.chat_keep_items;
create policy chat_keep_items_insert_own on public.chat_keep_items
  for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists chat_keep_items_update_own on public.chat_keep_items;
create policy chat_keep_items_update_own on public.chat_keep_items
  for update to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
drop policy if exists chat_keep_items_delete_own on public.chat_keep_items;
create policy chat_keep_items_delete_own on public.chat_keep_items
  for delete to authenticated using (user_id = (select auth.uid()));

create table if not exists public.chat_albums (
  id bigint primary key generated always as identity,
  group_id bigint not null references public.chat_groups(id) on delete cascade,
  name text not null,
  created_by uuid not null references public.chat_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_albums_name_length check (char_length(btrim(name)) between 1 and 80)
);

create index if not exists idx_chat_albums_group_updated
  on public.chat_albums (group_id, updated_at desc);

create table if not exists public.chat_album_items (
  id bigint primary key generated always as identity,
  album_id bigint not null references public.chat_albums(id) on delete cascade,
  group_id bigint not null references public.chat_groups(id) on delete cascade,
  message_id bigint not null references public.chat_messages(id) on delete cascade,
  storage_path text not null,
  caption text,
  added_by uuid not null references public.chat_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint chat_album_items_path_check check (storage_path ~ '^groups/[0-9]+/[A-Za-z0-9._-]+$'),
  constraint chat_album_items_unique_message unique (album_id, message_id)
);

create index if not exists idx_chat_album_items_album_created
  on public.chat_album_items (album_id, created_at desc);

alter table public.chat_albums enable row level security;
alter table public.chat_album_items enable row level security;

drop policy if exists chat_albums_select_member on public.chat_albums;
create policy chat_albums_select_member on public.chat_albums
  for select to authenticated using (public.chat_can_view_group(group_id));
drop policy if exists chat_albums_insert_member on public.chat_albums;
create policy chat_albums_insert_member on public.chat_albums
  for insert to authenticated with check (
    created_by = (select auth.uid()) and public.chat_can_send_group(group_id)
  );
drop policy if exists chat_albums_update_manager on public.chat_albums;
create policy chat_albums_update_manager on public.chat_albums
  for update to authenticated using (public.chat_can_manage_group(group_id))
  with check (public.chat_can_manage_group(group_id));
drop policy if exists chat_albums_delete_manager on public.chat_albums;
create policy chat_albums_delete_manager on public.chat_albums
  for delete to authenticated using (public.chat_can_manage_group(group_id));

drop policy if exists chat_album_items_select_member on public.chat_album_items;
create policy chat_album_items_select_member on public.chat_album_items
  for select to authenticated using (public.chat_can_view_group(group_id));
drop policy if exists chat_album_items_insert_member on public.chat_album_items;
create policy chat_album_items_insert_member on public.chat_album_items
  for insert to authenticated with check (
    added_by = (select auth.uid()) and public.chat_can_send_group(group_id)
    and exists (
      select 1 from public.chat_albums a
      where a.id = album_id and a.group_id = chat_album_items.group_id
        and public.chat_can_view_group(a.group_id)
    )
  );
drop policy if exists chat_album_items_delete_manager on public.chat_album_items;
create policy chat_album_items_delete_manager on public.chat_album_items
  for delete to authenticated using (public.chat_can_manage_group(group_id));

create or replace function public.chat_validate_album_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  msg_group bigint;
  msg_kind text;
  msg_path text;
begin
  select group_id, kind, payload #>> '{image,path}'
    into msg_group, msg_kind, msg_path
    from public.chat_messages where id = new.message_id;
  if msg_group is null or msg_group <> new.group_id or msg_kind <> 'image' then
    raise exception 'アルバムには同じルームの画像メッセージだけ追加できます';
  end if;
  if msg_path is null or msg_path <> new.storage_path
     or msg_path <> ('groups/' || new.group_id::text || '/' || split_part(new.storage_path, '/', 3)) then
    raise exception 'アルバム画像の保存先が不正です';
  end if;
  select 1 into msg_group from public.chat_albums
    where id = new.album_id and group_id = new.group_id;
  if not found then raise exception 'アルバムとルームが一致しません'; end if;
  return new;
end;
$$;

drop trigger if exists chat_album_items_validate on public.chat_album_items;
create trigger chat_album_items_validate
before insert or update on public.chat_album_items
for each row execute function public.chat_validate_album_item();

revoke all on table public.chat_keep_items, public.chat_albums, public.chat_album_items from anon;
grant select, insert, update, delete on public.chat_keep_items to authenticated;
grant select, insert, update, delete on public.chat_albums to authenticated;
grant select, insert, delete on public.chat_album_items to authenticated;
grant usage, select on all sequences in schema public to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_albums'
  ) then alter publication supabase_realtime add table public.chat_albums; end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_album_items'
  ) then alter publication supabase_realtime add table public.chat_album_items; end if;
end $$;

