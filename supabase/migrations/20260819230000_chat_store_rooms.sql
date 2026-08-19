-- 店舗固定ルーム。各 store_key に1つ。退出・削除できない。

alter table public.chat_groups
  add column if not exists store_key text,
  add column if not exists is_store_room boolean not null default false;

comment on column public.chat_groups.store_key is
  '店舗キー。店舗固定ルームと予約通知の紐付けに使う。';
comment on column public.chat_groups.is_store_room is
  '店舗固定ルーム。退出・削除できない。#メモ は Journal Report の資料へ送る。';

create unique index if not exists chat_groups_store_room_uidx
  on public.chat_groups (store_key)
  where is_store_room and store_key is not null;

-- 既存の店名ルームを流用
update public.chat_groups
set store_key = 'bistrocavacava', is_store_room = true
where id = 5 and coalesce(is_direct, false) = false;

update public.chat_groups
set store_key = 'marugo', is_store_room = true
where id = 6 and coalesce(is_direct, false) = false;

insert into public.chat_groups (group_name, created_by, is_direct, store_key, is_store_room)
select v.group_name, '00000000-0000-4000-8000-00000000b071'::uuid, false, v.store_key, true
from (values
  ('marugo', 'マルゴ'),
  ('marugosecond', 'マルゴ セカンド'),
  ('marugogrande', 'マルゴ グランデ'),
  ('sannanaichi', 'サンナナイチ バル'),
  ('shenlong', 'シェンロン&クラウディア'),
  ('claudia2', 'クラウディア2'),
  ('sauvage', 'ソバージュ'),
  ('barpelota', 'バルぺロタ'),
  ('briccola', 'トラットリア ブリッコラ'),
  ('violette', 'ヴィオレット'),
  ('marugootto', 'マルゴ オット'),
  ('donaiya', '元祖どないや 新宿三丁目店'),
  ('marugoyotsuya', 'マルゴ 四谷'),
  ('sushikoruri', '鮨こるり'),
  ('bistrocavacava', 'Bistro CAVACAVA'),
  ('marugoS', 'マルゴエス'),
  ('marugoshinbashi', 'マルゴ 新橋'),
  ('marugomarunouchi', 'マルゴ丸の内'),
  ('yakinikumarugo', '焼肉マルゴ'),
  ('erics', 'エリックスバイエリックトロション'),
  ('mitan', 'ミタン'),
  ('marugoD', 'マルゴ D')
) as v(store_key, group_name)
where not exists (
  select 1 from public.chat_groups g
  where g.is_store_room and g.store_key = v.store_key
);

insert into public.chat_group_members (group_id, user_id)
select g.id, u.id
from public.chat_groups g
cross join public.chat_users u
where g.is_store_room
on conflict (group_id, user_id) do nothing;

create or replace function public.chat_join_store_rooms()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.chat_group_members (group_id, user_id)
  select g.id, new.id
  from public.chat_groups g
  where g.is_store_room
  on conflict (group_id, user_id) do nothing;
  return new;
end;
$fn$;

drop trigger if exists chat_users_join_store_rooms on public.chat_users;
create trigger chat_users_join_store_rooms
after insert on public.chat_users
for each row execute function public.chat_join_store_rooms();

create or replace function public.chat_prevent_store_room_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if old.is_store_room then
    raise exception '店舗固定ルームは削除できません';
  end if;
  return old;
end;
$fn$;

drop trigger if exists chat_groups_prevent_store_room_delete on public.chat_groups;
create trigger chat_groups_prevent_store_room_delete
before delete on public.chat_groups
for each row execute function public.chat_prevent_store_room_delete();

create or replace function public.chat_leave_group(p_group_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null then
    raise exception 'ログインしてください';
  end if;
  if exists (
    select 1 from public.chat_groups
    where id = p_group_id and is_store_room
  ) then
    raise exception '店舗固定ルームは退出できません';
  end if;
  if not public.chat_is_member(p_group_id) then
    raise exception 'このルームに参加していません';
  end if;

  delete from public.chat_group_members
  where group_id = p_group_id
    and user_id = auth.uid();
end;
$fn$;

-- #メモ 処理を非同期で chat-knowledge に渡す
create or replace function public.chat_enqueue_knowledge_dispatch()
returns trigger
language plpgsql
security definer
set search_path = public, net, pg_catalog
as $fn$
declare
  v_secret text;
begin
  if new.user_id = '00000000-0000-4000-8000-00000000b071'::uuid then
    return new;
  end if;
  if not exists (
    select 1 from public.chat_groups g
    where g.id = new.group_id and g.is_store_room
  ) then
    return new;
  end if;

  select dispatch_secret into v_secret
  from public.chat_push_internal_config
  where id = true;

  if v_secret is null or v_secret = '' then
    return new;
  end if;

  perform net.http_post(
    url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/chat-knowledge?action=dispatch',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_secret,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('message_id', new.id)
  );
  return new;
exception
  when others then
    return new;
end;
$fn$;

drop trigger if exists chat_messages_enqueue_knowledge on public.chat_messages;
create trigger chat_messages_enqueue_knowledge
after insert on public.chat_messages
for each row execute function public.chat_enqueue_knowledge_dispatch();

revoke all on function public.chat_join_store_rooms() from public, anon, authenticated;
revoke all on function public.chat_prevent_store_room_delete() from public, anon, authenticated;
revoke all on function public.chat_enqueue_knowledge_dispatch() from public, anon, authenticated;
