-- 承認カードを予約通知Botの1対1へ送らない。
-- 完全削除した予約通知ルームは、同じ相手の1対1キーで復活させていた。
-- 管理者だけが参加する専用ルームへ送る。

alter table public.chat_groups
  add column if not exists is_admin_notice_room boolean not null default false;

comment on column public.chat_groups.is_admin_notice_room is
  '新規登録・所属変更の許可カード専用。管理権限がある人だけ参加する。予約通知の1対1とは別。';

create unique index if not exists chat_groups_admin_notice_room_uidx
  on public.chat_groups (is_admin_notice_room)
  where is_admin_notice_room;

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at,
  raw_app_meta_data,
  raw_user_meta_data,
  is_sso_user,
  is_anonymous,
  banned_until
) values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-4000-8000-00000000b072',
  'authenticated',
  'authenticated',
  'admin-notice-bot@marugo.invalid',
  extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')),
  now(),
  now(),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"bot":true,"admin_notice":true}'::jsonb,
  false,
  false,
  'infinity'
)
on conflict (id) do nothing;

insert into public.chat_users (id, username, is_bot)
values ('00000000-0000-4000-8000-00000000b072', '管理者通知', true)
on conflict (id) do update
  set is_bot = true,
      username = excluded.username;

create or replace function public.chat_protect_group_security_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is not null and (
    new.id is distinct from old.id
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
    or new.is_direct is distinct from old.is_direct
    or new.direct_key is distinct from old.direct_key
    or new.store_key is distinct from old.store_key
    or new.is_store_room is distinct from old.is_store_room
    or new.is_admin_notice_room is distinct from old.is_admin_notice_room
  ) then
    raise exception 'ルームのシステム項目は変更できません';
  end if;

  if auth.uid() is not null
    and (
      new.trashed_at is distinct from old.trashed_at
      or new.trashed_by is distinct from old.trashed_by
    )
    and current_setting('chat.allow_trash', true) is distinct from '1'
  then
    raise exception 'ゴミ箱の操作は専用の操作から行ってください';
  end if;
  return new;
end;
$fn$;

create or replace function public.chat_ensure_manager_notice_room()
returns bigint
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_bot uuid := '00000000-0000-4000-8000-00000000b072';
  v_id bigint;
begin
  select id into v_id
  from public.chat_groups
  where is_admin_notice_room
  limit 1;

  if v_id is not null then
    if exists (
      select 1 from public.chat_groups
      where id = v_id and trashed_at is not null
    ) then
      perform set_config('chat.allow_trash', '1', true);
      update public.chat_groups
      set trashed_at = null,
          trashed_by = null
      where id = v_id;
    end if;
  else
    insert into public.chat_groups (
      group_name, created_by, is_direct, direct_key, is_admin_notice_room
    ) values (
      '管理者通知', v_bot, false, null, true
    )
    returning id into v_id;
  end if;

  perform set_config('chat.allow_member_permission_update', '1', true);

  insert into public.chat_group_members (
    group_id, user_id, can_view, can_send, can_invite, can_manage
  ) values (
    v_id, v_bot, true, true, false, false
  )
  on conflict (group_id, user_id) do nothing;

  insert into public.chat_group_members (
    group_id, user_id, can_view, can_send, can_invite, can_manage
  )
  select v_id, gm.user_id, true, true, false, true
  from public.chat_group_members gm
  join public.chat_groups g on g.id = gm.group_id
  join public.chat_users u on u.id = gm.user_id
  where gm.can_view = true
    and gm.can_manage = true
    and not coalesce(g.is_direct, false)
    and not coalesce(g.is_admin_notice_room, false)
    and g.trashed_at is null
    and coalesce(u.is_bot, false) = false
    and public.chat_has_active_access(gm.user_id)
  group by gm.user_id
  on conflict (group_id, user_id) do update
    set can_view = true,
        can_send = true,
        can_invite = false,
        can_manage = true;

  delete from public.chat_group_members m
  where m.group_id = v_id
    and m.user_id <> v_bot
    and not public.chat_is_signup_manager(m.user_id);

  return v_id;
end;
$fn$;

revoke all on function public.chat_ensure_manager_notice_room()
  from public, anon, authenticated;
grant execute on function public.chat_ensure_manager_notice_room() to service_role;

create or replace function public.chat_protect_admin_notice_room()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if tg_op = 'DELETE' then
    if old.is_admin_notice_room then
      raise exception '管理者通知ルームは削除できません';
    end if;
    return old;
  end if;
  if old.is_admin_notice_room and new.trashed_at is not null then
    raise exception '管理者通知ルームは削除できません';
  end if;
  return new;
end;
$fn$;

drop trigger if exists chat_groups_protect_admin_notice_room on public.chat_groups;
create trigger chat_groups_protect_admin_notice_room
before update or delete on public.chat_groups
for each row execute function public.chat_protect_admin_notice_room();

-- 以前の予約通知1対1向けRPCは、同じ相手のDMを復活させない。
create or replace function public.chat_ensure_manager_notice_direct(p_user_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $fn$
begin
  return public.chat_ensure_manager_notice_room();
end;
$fn$;
