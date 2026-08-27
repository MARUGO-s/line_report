-- 承認・所属変更のカードは店舗ルーム全員に見せない。
-- 管理者本人との1対1へ送り、既存の店舗ルーム内カードは管理権限がある人だけ読める。

create or replace function public.chat_is_admin_notice_message(p_kind text, p_payload jsonb)
returns boolean
language sql
immutable
set search_path = public
as $fn$
  select coalesce(p_kind, '') = 'card'
    and coalesce(p_payload ->> 'kind', '') in (
      'signup_approval',
      'signup_reviewed',
      'store_change',
      'store_change_reviewed'
    )
$fn$;

revoke all on function public.chat_is_admin_notice_message(text, jsonb) from public, anon;
grant execute on function public.chat_is_admin_notice_message(text, jsonb) to authenticated, service_role;

create or replace function public.chat_can_see_admin_notice(
  p_group_id bigint,
  p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select public.chat_has_active_access(p_user_id) and (
    exists (
      select 1
      from public.chat_group_members gm
      join public.chat_groups g on g.id = gm.group_id
      where gm.group_id = p_group_id
        and gm.user_id = p_user_id
        and gm.can_view = true
        and gm.can_manage = true
        and not coalesce(g.is_direct, false)
        and g.trashed_at is null
    )
    or (
      public.chat_is_signup_manager(p_user_id)
      and exists (
        select 1 from public.chat_groups g
        where g.id = p_group_id and coalesce(g.is_direct, false)
      )
    )
  )
$fn$;

revoke all on function public.chat_can_see_admin_notice(bigint, uuid) from public, anon;
grant execute on function public.chat_can_see_admin_notice(bigint, uuid) to authenticated, service_role;

drop policy if exists chat_messages_select_since_join on public.chat_messages;
create policy chat_messages_select_since_join on public.chat_messages
  for select to authenticated
  using (
    public.chat_can_read_message(group_id, created_at)
    and (
      not public.chat_is_admin_notice_message(kind, payload)
      or public.chat_can_see_admin_notice(group_id)
    )
  );

create or replace function public.chat_unread_counts()
returns table (group_id bigint, unread_count bigint)
language sql
stable
security definer
set search_path = public
as $fn$
  select m.group_id, count(*)::bigint
  from public.chat_messages m
  join public.chat_group_members gm
    on gm.group_id = m.group_id
   and gm.user_id = auth.uid()
   and gm.can_view
   and m.created_at >= gm.joined_at
  join public.chat_user_access a
    on a.user_id = gm.user_id
   and a.access_enabled
   and a.deleted_at is null
   and (a.restricted_until is null or a.restricted_until <= now())
  left join public.chat_read_states rs
    on rs.group_id = m.group_id and rs.user_id = auth.uid()
  where m.user_id <> auth.uid()
    and (rs.last_read_at is null or m.created_at > rs.last_read_at)
    and (
      not public.chat_is_admin_notice_message(m.kind, m.payload)
      or public.chat_can_see_admin_notice(m.group_id, gm.user_id)
    )
  group by m.group_id
$fn$;

create or replace function public.chat_push_unread_totals(p_user_ids uuid[])
returns table (user_id uuid, unread_count bigint)
language sql
stable
security definer
set search_path = public
as $fn$
  with recipients as (
    select distinct value as user_id
    from unnest(coalesce(p_user_ids, array[]::uuid[])) as ids(value)
    where value is not null
  )
  select recipients.user_id,
         count(m.id)::bigint as unread_count
  from recipients
  join public.chat_user_access a
    on a.user_id = recipients.user_id
   and a.access_enabled
   and a.deleted_at is null
   and (a.restricted_until is null or a.restricted_until <= now())
  left join public.chat_group_members gm
    on gm.user_id = recipients.user_id
   and gm.can_view
  left join public.chat_read_states rs
    on rs.group_id = gm.group_id
   and rs.user_id = recipients.user_id
  left join public.chat_messages m
    on m.group_id = gm.group_id
   and m.created_at >= gm.joined_at
   and m.user_id <> recipients.user_id
   and (rs.last_read_at is null or m.created_at > rs.last_read_at)
   and (
     not public.chat_is_admin_notice_message(m.kind, m.payload)
     or public.chat_can_see_admin_notice(m.group_id, recipients.user_id)
   )
  group by recipients.user_id
$fn$;

create or replace function public.chat_ensure_manager_notice_direct(p_user_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_bot uuid := '00000000-0000-4000-8000-00000000b071';
  v_key text;
  v_id bigint;
  v_name text;
begin
  if p_user_id is null or p_user_id = v_bot then
    raise exception '通知先が不正です';
  end if;
  if not exists (
    select 1 from public.chat_users
    where id = p_user_id and coalesce(is_bot, false) = false
  ) then
    raise exception 'ユーザーが見つかりません';
  end if;
  if not public.chat_is_signup_manager(p_user_id) then
    raise exception '管理権限がありません';
  end if;

  if p_user_id::text < v_bot::text then
    v_key := p_user_id::text || ':' || v_bot::text;
  else
    v_key := v_bot::text || ':' || p_user_id::text;
  end if;

  select id into v_id
  from public.chat_groups
  where direct_key = v_key and is_direct;

  select username into v_name from public.chat_users where id = p_user_id;

  if v_id is null then
    insert into public.chat_groups (group_name, created_by, is_direct, direct_key)
    values (coalesce(v_name, '管理者'), v_bot, true, v_key)
    returning id into v_id;
  end if;

  insert into public.chat_group_members (
    group_id, user_id, can_view, can_send, can_invite, can_manage
  ) values
    (v_id, v_bot, true, true, false, false),
    (v_id, p_user_id, true, true, false, false)
  on conflict (group_id, user_id) do nothing;

  return v_id;
end;
$fn$;

revoke all on function public.chat_ensure_manager_notice_direct(uuid)
  from public, anon, authenticated;
grant execute on function public.chat_ensure_manager_notice_direct(uuid) to service_role;

create or replace function public.chat_add_members(
  p_group_id bigint,
  p_user_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_direct boolean;
begin
  if auth.uid() is null or not public.chat_can_invite_group(p_group_id) then
    raise exception 'このルームへ招待する権限がありません';
  end if;
  select coalesce(is_direct, false) into v_direct
  from public.chat_groups where id = p_group_id;
  if not found then raise exception 'ルームが見つかりません'; end if;
  if v_direct then raise exception '1対1トークには追加できません'; end if;

  if exists (
    select 1
    from unnest(coalesce(p_user_ids, '{}'::uuid[])) ids(user_id)
    where ids.user_id is null
       or not public.chat_has_active_access(ids.user_id)
       or not public.chat_user_can_join_group_by_store(p_group_id, ids.user_id)
  ) then
    raise exception '招待できないユーザーが含まれています';
  end if;

  perform set_config('chat.allow_member_permission_update', '1', true);

  insert into public.chat_group_members (
    group_id, user_id, can_view, can_send, can_invite, can_manage
  )
  select p_group_id, ids.user_id, perms.can_view, perms.can_send, perms.can_invite, perms.can_manage
  from (
    select distinct user_id
    from unnest(coalesce(p_user_ids, '{}'::uuid[])) members(user_id)
    where user_id is not null
  ) ids
  cross join lateral public.chat_new_member_permissions(ids.user_id) perms
  on conflict (group_id, user_id) do update
    set can_view = excluded.can_view,
        can_send = excluded.can_send,
        can_invite = excluded.can_invite
    where public.chat_group_members.can_manage = false
      and excluded.can_send = false;
end;
$fn$;

-- 承認後の閲覧ユーザーに残っていた送信・招待を落とす。管理権限は触らない。
update public.chat_group_members m
set can_send = false,
    can_invite = false
from public.chat_user_access a
join public.chat_users u on u.id = a.user_id
where m.user_id = a.user_id
  and coalesce(u.is_bot, false) = false
  and a.default_can_send = false
  and coalesce(m.can_manage, false) = false
  and (m.can_send = true or m.can_invite = true);
