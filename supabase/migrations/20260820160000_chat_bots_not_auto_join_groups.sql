-- 店舗Botはグループへ自動参加しない。招待されたルームか、1:1 だけ。

create or replace function public.chat_join_store_rooms()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.is_bot then
    return new;
  end if;

  insert into public.chat_group_members (group_id, user_id)
  select g.id, new.id
  from public.chat_groups g
  where g.is_store_room
  on conflict (group_id, user_id) do nothing;
  return new;
end;
$fn$;

delete from public.chat_group_members m
using public.chat_users u, public.chat_groups g
where m.user_id = u.id
  and m.group_id = g.id
  and u.is_bot
  and u.store_key is not null
  and g.is_store_room;
