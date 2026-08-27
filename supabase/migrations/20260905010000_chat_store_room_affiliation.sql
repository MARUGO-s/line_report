-- 新規ユーザーを全店舗ルームへ送信・招待つきで入れない。
-- 所属店舗のルームだけ、閲覧のみ（default_can_send に従う）で参加させる。
-- 承認済みの閲覧ユーザーが他店へ残っている分は外す。

create or replace function public.chat_protect_member_permissions()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_is_direct boolean;
begin
  select coalesce(g.is_direct, false)
    into v_is_direct
  from public.chat_groups g
  where g.id = new.group_id;

  if v_is_direct and (new.can_invite = true or new.can_manage = true) then
    raise exception '1対1トークでは招待・管理権限を付与できません';
  end if;

  if tg_op = 'UPDATE' then
    if auth.uid() is not null
      and current_setting('chat.allow_member_permission_update', true) is distinct from '1'
      and (
        new.can_view is distinct from old.can_view
        or new.can_send is distinct from old.can_send
        or new.can_invite is distinct from old.can_invite
        or new.can_manage is distinct from old.can_manage
      )
    then
      raise exception 'ルーム権限は管理画面または専用操作から変更してください';
    end if;
  end if;
  return new;
end;
$fn$;

create or replace function public.chat_sync_user_store_rooms(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_send boolean;
  v_viewer boolean;
begin
  if p_user_id is null then
    return;
  end if;
  if exists (select 1 from public.chat_users where id = p_user_id and coalesce(is_bot, false)) then
    return;
  end if;

  select coalesce(default_can_send, true)
    into v_send
  from public.chat_user_access
  where user_id = p_user_id;
  if not found then
    v_send := true;
  end if;

  select exists (
    select 1
    from public.chat_user_access a
    where a.user_id = p_user_id
      and a.default_can_send = false
      and a.can_start_direct = false
      and a.can_create_group = false
      and a.can_browse_users = false
      and a.signup_status = 'approved'
      and a.deleted_at is null
  ) into v_viewer;

  perform set_config('chat.allow_member_permission_update', '1', true);

  if v_viewer then
    delete from public.chat_group_members m
    using public.chat_groups g
    where m.group_id = g.id
      and m.user_id = p_user_id
      and g.is_store_room
      and coalesce(m.can_manage, false) = false
      and not exists (
        select 1
        from public.chat_user_stores s
        where s.user_id = p_user_id
          and s.store_key = g.store_key
      );
  end if;

  insert into public.chat_group_members (
    group_id, user_id, can_view, can_send, can_invite, can_manage
  )
  select g.id, p_user_id, perms.can_view, perms.can_send, perms.can_invite, perms.can_manage
  from public.chat_groups g
  join public.chat_user_stores s
    on s.user_id = p_user_id and s.store_key = g.store_key
  cross join lateral public.chat_new_member_permissions(p_user_id) perms
  where g.is_store_room
  on conflict (group_id, user_id) do nothing;

  if v_viewer then
    update public.chat_group_members m
    set can_view = true,
        can_send = false,
        can_invite = false,
        can_manage = false
    from public.chat_groups g
    where m.group_id = g.id
      and m.user_id = p_user_id
      and g.is_store_room
      and coalesce(m.can_manage, false) = false
      and (
        m.can_send = true
        or m.can_invite = true
      );
  end if;
end;
$fn$;

comment on function public.chat_sync_user_store_rooms(uuid) is
  '所属店舗の固定ルームへ参加させる。閲覧スタートのユーザーは他店ルームから外し、送信・招待を付けない。';

revoke all on function public.chat_sync_user_store_rooms(uuid)
  from public, anon, authenticated;
grant execute on function public.chat_sync_user_store_rooms(uuid) to service_role;

create or replace function public.chat_apply_user_stores(
  p_user_id uuid,
  p_store_keys text[]
)
returns text[]
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_keys text[] := public.chat_normalize_store_keys(p_store_keys);
begin
  delete from public.chat_user_stores where user_id = p_user_id;
  insert into public.chat_user_stores (user_id, store_key)
  select p_user_id, k
  from unnest(v_keys) k;
  perform public.chat_sync_user_store_rooms(p_user_id);
  return v_keys;
end;
$fn$;

revoke all on function public.chat_apply_user_stores(uuid, text[])
  from public, anon, authenticated;
grant execute on function public.chat_apply_user_stores(uuid, text[]) to service_role;

create or replace function public.chat_join_store_rooms()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if coalesce(new.is_bot, false) then
    if nullif(btrim(new.store_key), '') is not null then
      insert into public.chat_group_members (
        group_id, user_id, can_view, can_send, can_invite, can_manage
      )
      select g.id, new.id, true, true, true, false
      from public.chat_groups g
      where g.is_store_room and g.store_key = new.store_key
      on conflict (group_id, user_id) do nothing;
    end if;
    return new;
  end if;
  -- 人間は所属店舗の承認後に chat_sync_user_store_rooms で入れる。
  return new;
end;
$fn$;

create or replace function public.chat_user_can_join_group_by_store(
  p_group_id bigint,
  p_user_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_store text;
  v_direct boolean;
  v_bot boolean;
  v_bot_store text;
begin
  select nullif(btrim(store_key), ''), coalesce(is_direct, false)
    into v_store, v_direct
  from public.chat_groups
  where id = p_group_id;
  if not found then return false; end if;
  if v_direct then return true; end if;

  select coalesce(is_bot, false), nullif(btrim(store_key), '')
    into v_bot, v_bot_store
  from public.chat_users
  where id = p_user_id;
  if not found then return false; end if;

  if v_bot then
    if v_store is null then
      return public.chat_shares_affiliation(auth.uid(), p_user_id);
    end if;
    return v_bot_store is not distinct from v_store;
  end if;

  if v_store is not null then
    return exists (
      select 1 from public.chat_user_stores s
      where s.user_id = p_user_id and s.store_key = v_store
    );
  end if;

  return public.chat_shares_affiliation(auth.uid(), p_user_id);
end;
$fn$;

revoke all on function public.chat_user_can_join_group_by_store(bigint, uuid)
  from public, anon;
grant execute on function public.chat_user_can_join_group_by_store(bigint, uuid)
  to authenticated, service_role;

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
  on conflict (group_id, user_id) do nothing;
end;
$fn$;

-- 承認済みの閲覧スタートユーザーを、今入っている他店ルームから外し閲覧のみにする。
do $backfill$
declare
  r record;
begin
  for r in
    select a.user_id
    from public.chat_user_access a
    join public.chat_users u on u.id = a.user_id
    where coalesce(u.is_bot, false) = false
      and a.default_can_send = false
      and a.can_start_direct = false
      and a.can_create_group = false
      and a.can_browse_users = false
      and a.signup_status = 'approved'
      and a.deleted_at is null
  loop
    perform public.chat_sync_user_store_rooms(r.user_id);
  end loop;
end
$backfill$;
