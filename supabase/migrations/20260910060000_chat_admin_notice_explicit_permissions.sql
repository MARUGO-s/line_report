-- The private approval room is synchronized whenever reviewers change or a
-- review card is queued. Keep reviewer visibility in sync, but do not erase a
-- room-level invite/manage grant that headquarters explicitly assigned.

create or replace function public.chat_ensure_manager_notice_room()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
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
  on conflict (group_id, user_id) do update
    set can_view = true,
        can_send = true,
        can_invite = false,
        can_manage = false;

  insert into public.chat_group_members (
    group_id, user_id, can_view, can_send, can_invite, can_manage
  )
  select v_id, u.id, true, true, false, false
  from public.chat_users u
  where coalesce(u.is_bot, false) = false
    and public.chat_is_signup_manager(u.id)
  on conflict (group_id, user_id) do update
    set can_view = true,
        can_send = true,
        can_invite = chat_group_members.can_invite,
        can_manage = chat_group_members.can_manage;

  delete from public.chat_group_members m
  where m.group_id = v_id
    and m.user_id <> v_bot
    and not public.chat_is_signup_manager(m.user_id);

  return v_id;
end;
$fn$;

revoke all on function public.chat_ensure_manager_notice_room()
  from public, anon, authenticated;
grant execute on function public.chat_ensure_manager_notice_room()
  to postgres, service_role;

select public.chat_ensure_manager_notice_room();
