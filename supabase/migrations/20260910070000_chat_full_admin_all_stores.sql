-- Headquarters-only full M-talk administrator role.
-- A full administrator receives every store and every non-direct room, while
-- ordinary reviewers and room managers keep their existing narrow scopes.

alter table public.chat_user_access
  add column if not exists is_full_admin boolean not null default false;

comment on column public.chat_user_access.is_full_admin is
  'Headquarters-only full M-talk administrator. Automatically covers every store and every non-direct room.';

create or replace function public.chat_is_full_admin(
  p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $fn$
  select exists (
    select 1
    from public.chat_user_access a
    join public.chat_users u on u.id = a.user_id
    where a.user_id = p_user_id
      and a.is_full_admin = true
      and a.access_enabled = true
      and a.signup_status = 'approved'
      and a.deleted_at is null
      and (a.restricted_until is null or a.restricted_until <= now())
      and coalesce(u.is_bot, false) = false
  )
$fn$;

revoke all on function public.chat_is_full_admin(uuid)
  from public, anon, authenticated;
grant execute on function public.chat_is_full_admin(uuid)
  to postgres, service_role;

-- Full administrators cannot reduce their own store scope through a profile
-- request. Applying any store list to an active full administrator resolves to
-- the complete catalog instead.
create or replace function public.chat_apply_user_stores(
  p_user_id uuid,
  p_store_keys text[]
)
returns text[]
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
declare
  v_keys text[];
begin
  if public.chat_is_full_admin(p_user_id) then
    select coalesce(array_agg(c.store_key order by c.sort_order), array[]::text[])
      into v_keys
    from public.chat_store_catalog c;
  else
    v_keys := public.chat_normalize_store_keys(p_store_keys);
  end if;

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
grant execute on function public.chat_apply_user_stores(uuid, text[])
  to postgres, service_role;

-- Reviewers still receive the private notice room without room-management
-- authority. An explicitly designated full administrator receives all four
-- room permissions and an explicit room grant is never downgraded by sync.
create or replace function public.chat_ensure_manager_notice_room()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
declare
  v_bot uuid := '00000000-0000-4000-8000-00000000b072'::uuid;
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
  select
    v_id,
    u.id,
    true,
    true,
    public.chat_is_full_admin(u.id),
    public.chat_is_full_admin(u.id)
  from public.chat_users u
  where coalesce(u.is_bot, false) = false
    and public.chat_is_signup_manager(u.id)
  on conflict (group_id, user_id) do update
    set can_view = true,
        can_send = true,
        can_invite = chat_group_members.can_invite or excluded.can_invite,
        can_manage = chat_group_members.can_manage or excluded.can_manage;

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

create or replace function public.chat_sync_full_admin_scope(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
begin
  if not public.chat_is_full_admin(p_user_id) then
    raise exception using errcode = '42501', message = '有効な全権管理者ではありません';
  end if;

  perform public.chat_apply_user_stores(p_user_id, array[]::text[]);
  perform public.chat_ensure_manager_notice_room();
  perform set_config('chat.allow_member_permission_update', '1', true);

  insert into public.chat_group_members (
    group_id, user_id, can_view, can_send, can_invite, can_manage
  )
  select g.id, p_user_id, true, true, true, true
  from public.chat_groups g
  where g.trashed_at is null
    and coalesce(g.is_direct, false) = false
  on conflict (group_id, user_id) do update
    set can_view = true,
        can_send = true,
        can_invite = true,
        can_manage = true,
        hidden_at = null;
end;
$fn$;

revoke all on function public.chat_sync_full_admin_scope(uuid)
  from public, anon, authenticated;
grant execute on function public.chat_sync_full_admin_scope(uuid)
  to postgres, service_role;

-- A full administrator cannot be silently downgraded or removed from an
-- active shared room by an ordinary room operation. Direct rooms are excluded.
create or replace function public.chat_enforce_full_admin_membership()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
declare
  v_shared_active boolean;
  v_bypass boolean := coalesce(current_setting(
    'chat.allow_full_admin_permission_change', true
  ), '') = '1';
begin
  if tg_op = 'DELETE' then
    select coalesce(not g.is_direct and g.trashed_at is null, false)
      into v_shared_active
    from public.chat_groups g
    where g.id = old.group_id;

    if not v_bypass
      and v_shared_active
      and public.chat_is_full_admin(old.user_id)
    then
      raise exception using
        errcode = '42501',
        message = '全権管理者は共有ルームから外せません。先に全権管理者を解除してください';
    end if;
    return old;
  end if;

  select coalesce(not g.is_direct and g.trashed_at is null, false)
    into v_shared_active
  from public.chat_groups g
  where g.id = new.group_id;

  if not v_bypass
    and v_shared_active
    and public.chat_is_full_admin(new.user_id)
  then
    new.can_view := true;
    new.can_send := true;
    new.can_invite := true;
    new.can_manage := true;
    new.hidden_at := null;
  end if;
  return new;
end;
$fn$;

revoke all on function public.chat_enforce_full_admin_membership()
  from public, anon, authenticated;

drop trigger if exists chat_group_members_enforce_full_admin
  on public.chat_group_members;
create trigger chat_group_members_enforce_full_admin
before insert or update or delete on public.chat_group_members
for each row execute function public.chat_enforce_full_admin_membership();

-- New and restored shared rooms automatically include every active full
-- administrator, including a full administrator who created the room.
create or replace function public.chat_add_full_admins_to_shared_room()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
begin
  if coalesce(new.is_direct, false) or new.trashed_at is not null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.trashed_at is null then
    return new;
  end if;

  perform set_config('chat.allow_member_permission_update', '1', true);
  insert into public.chat_group_members (
    group_id, user_id, can_view, can_send, can_invite, can_manage
  )
  select new.id, a.user_id, true, true, true, true
  from public.chat_user_access a
  where public.chat_is_full_admin(a.user_id)
  on conflict (group_id, user_id) do update
    set can_view = true,
        can_send = true,
        can_invite = true,
        can_manage = true,
        hidden_at = null;
  return new;
end;
$fn$;

revoke all on function public.chat_add_full_admins_to_shared_room()
  from public, anon, authenticated;

drop trigger if exists chat_groups_add_full_admins on public.chat_groups;
create trigger chat_groups_add_full_admins
after insert or update of trashed_at on public.chat_groups
for each row execute function public.chat_add_full_admins_to_shared_room();

-- The room trigger may already have inserted a full-administrator creator.
-- Keep normal group creation idempotent for that one membership while leaving
-- every existing validation and invited-user default unchanged.
create or replace function public.chat_create_group(
  p_group_name text,
  p_member_ids uuid[] default '{}'
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
declare
  v_me uuid := auth.uid();
  v_group_id bigint;
  v_name text := btrim(coalesce(p_group_name, ''));
begin
  if v_me is null or not public.chat_is_registered() then
    raise exception 'ログインしてください';
  end if;
  if not exists (
    select 1 from public.chat_user_access a
    where a.user_id = v_me and a.can_create_group
  ) then
    raise exception 'グループを作成する権限がありません';
  end if;
  if v_name = '' or char_length(v_name) > 120 then
    raise exception 'グループ名は1〜120文字で入力してください';
  end if;
  if exists (
    select 1
    from unnest(coalesce(p_member_ids, '{}'::uuid[])) ids(user_id)
    where ids.user_id is null
       or not public.chat_has_active_access(ids.user_id)
       or (
         ids.user_id <> v_me
         and not public.chat_shares_affiliation(v_me, ids.user_id)
       )
  ) then
    raise exception '招待できないユーザーが含まれています';
  end if;

  insert into public.chat_groups (group_name, created_by, is_direct, direct_key)
  values (v_name, v_me, false, null)
  returning id into v_group_id;

  insert into public.chat_group_members (
    group_id, user_id, can_view, can_send, can_invite, can_manage
  ) values (
    v_group_id, v_me, true, true, true, true
  )
  on conflict (group_id, user_id) do nothing;

  insert into public.chat_group_members (
    group_id, user_id, can_view, can_send, can_invite, can_manage
  )
  select v_group_id, ids.user_id, perms.can_view, perms.can_send, perms.can_invite, perms.can_manage
  from (
    select distinct user_id
    from unnest(coalesce(p_member_ids, '{}'::uuid[])) members(user_id)
    where user_id is not null and user_id <> v_me
  ) ids
  cross join lateral public.chat_new_member_permissions(ids.user_id) perms
  on conflict (group_id, user_id) do nothing;

  return v_group_id;
end;
$fn$;

-- New stores immediately become part of every active full administrator's
-- calendar and store scope.
create or replace function public.chat_add_store_to_full_admins()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
begin
  insert into public.chat_user_stores (user_id, store_key)
  select a.user_id, new.store_key
  from public.chat_user_access a
  where public.chat_is_full_admin(a.user_id)
  on conflict (user_id, store_key) do nothing;
  return new;
end;
$fn$;

revoke all on function public.chat_add_store_to_full_admins()
  from public, anon, authenticated;

drop trigger if exists chat_store_catalog_add_full_admins
  on public.chat_store_catalog;
create trigger chat_store_catalog_add_full_admins
after insert on public.chat_store_catalog
for each row execute function public.chat_add_store_to_full_admins();

-- Prevent service-backed delegated administration from changing a full
-- administrator through the ordinary access RPC. Only the dedicated HQ-only
-- operation below sets the local bypass flag.
create or replace function public.chat_protect_full_admin_access()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
declare
  v_bypass boolean := coalesce(current_setting(
    'chat.allow_full_admin_access_change', true
  ), '') = '1';
begin
  if tg_op = 'INSERT' then
    if new.is_full_admin and not v_bypass then
      raise exception using errcode = '42501', message = '全権管理者は専用操作で設定してください';
    end if;
    return new;
  end if;

  if not v_bypass and (
    new.is_full_admin is distinct from old.is_full_admin
    or (
      old.is_full_admin
      and (
        new.access_enabled is distinct from old.access_enabled
        or new.can_start_direct is distinct from old.can_start_direct
        or new.can_create_group is distinct from old.can_create_group
        or new.can_browse_users is distinct from old.can_browse_users
        or new.default_can_send is distinct from old.default_can_send
        or new.can_use_journal_ai is distinct from old.can_use_journal_ai
        or new.can_review_access is distinct from old.can_review_access
        or new.signup_status is distinct from old.signup_status
        or new.restriction_reason is distinct from old.restriction_reason
        or new.restricted_until is distinct from old.restricted_until
        or new.deleted_at is distinct from old.deleted_at
      )
    )
  ) then
    raise exception using
      errcode = '42501',
      message = '全権管理者の変更は専用操作を使用してください';
  end if;
  return new;
end;
$fn$;

revoke all on function public.chat_protect_full_admin_access()
  from public, anon, authenticated;

drop trigger if exists chat_user_access_protect_full_admin
  on public.chat_user_access;
create trigger chat_user_access_protect_full_admin
before insert or update on public.chat_user_access
for each row execute function public.chat_protect_full_admin_access();

-- Headquarters-only designation. Granting synchronizes every current store
-- and shared room. Revoking fails closed: M-talk is stopped and ordinary
-- permissions must be deliberately assigned again.
create or replace function public.chat_admin_set_full_admin(
  p_user_id uuid,
  p_enabled boolean,
  p_expected_updated_at timestamptz,
  p_actor text
)
returns public.chat_user_access
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
declare
  v_before public.chat_user_access;
  v_after public.chat_user_access;
  v_is_bot boolean;
  v_actor text := left(coalesce(nullif(btrim(p_actor), ''), 'chat-admin'), 200);
  v_before_stores text[];
  v_before_managed_rooms bigint[];
  v_after_stores text[];
  v_after_managed_rooms bigint[];
  v_previous_access_bypass text := current_setting(
    'chat.allow_full_admin_access_change', true
  );
begin
  if p_enabled is null then
    raise exception '全権管理者の設定値が必要です';
  end if;

  select coalesce(u.is_bot, false) into v_is_bot
  from public.chat_users u
  where u.id = p_user_id;
  if not found then raise exception 'ユーザーが見つかりません'; end if;
  if v_is_bot then raise exception 'Botを全権管理者にはできません'; end if;

  insert into public.chat_user_access (user_id) values (p_user_id)
  on conflict (user_id) do nothing;
  select * into v_before
  from public.chat_user_access
  where user_id = p_user_id
  for update;

  if v_before.deleted_at is not null then
    raise exception '削除済みユーザーは先に復元してください';
  end if;
  if p_expected_updated_at is null
    or v_before.updated_at is distinct from p_expected_updated_at
  then
    raise exception using
      errcode = '40001',
      message = '別の管理者が先に更新しました。再読み込みしてください';
  end if;
  if v_before.is_full_admin is not distinct from p_enabled then
    raise exception '全権管理者の状態が変わっていません';
  end if;

  select coalesce(array_agg(s.store_key order by s.store_key), array[]::text[])
    into v_before_stores
  from public.chat_user_stores s
  where s.user_id = p_user_id;
  select coalesce(array_agg(m.group_id order by m.group_id)
                  filter (where m.can_manage), array[]::bigint[])
    into v_before_managed_rooms
  from public.chat_group_members m
  join public.chat_groups g on g.id = m.group_id
  where m.user_id = p_user_id
    and coalesce(g.is_direct, false) = false;

  perform set_config('chat.allow_full_admin_access_change', '1', true);
  perform set_config('chat.allow_member_permission_update', '1', true);

  if p_enabled then
    update public.chat_user_access
    set is_full_admin = true,
        access_enabled = true,
        can_start_direct = true,
        can_create_group = true,
        can_browse_users = true,
        default_can_send = true,
        can_use_journal_ai = true,
        can_review_access = true,
        signup_status = 'approved',
        restriction_reason = null,
        restricted_until = null,
        deleted_at = null,
        updated_at = clock_timestamp(),
        updated_by = v_actor
    where user_id = p_user_id;

    perform public.chat_sync_full_admin_scope(p_user_id);
  else
    update public.chat_user_access
    set is_full_admin = false,
        access_enabled = false,
        can_start_direct = false,
        can_create_group = false,
        can_browse_users = false,
        default_can_send = false,
        can_use_journal_ai = false,
        can_review_access = false,
        restriction_reason = '全権管理者を解除しました。通常権限を再設定してください。',
        restricted_until = null,
        updated_at = clock_timestamp(),
        updated_by = v_actor
    where user_id = p_user_id;

    update public.chat_group_members m
    set can_view = false,
        can_send = false,
        can_invite = false,
        can_manage = false
    from public.chat_groups g
    where m.group_id = g.id
      and m.user_id = p_user_id
      and coalesce(g.is_direct, false) = false;

    delete from public.chat_user_stores
    where user_id = p_user_id;
    perform public.chat_sync_user_store_rooms(p_user_id);
    perform public.chat_ensure_manager_notice_room();
  end if;

  -- Do not leak the dedicated-role bypass to a caller that wraps this RPC in
  -- a larger transaction. The room-membership bypass is intentionally never
  -- enabled here: grant writes the required true values, and revoke clears the
  -- role before removing its shared-room permissions.
  perform set_config(
    'chat.allow_full_admin_access_change',
    coalesce(v_previous_access_bypass, ''),
    true
  );

  select * into v_after
  from public.chat_user_access
  where user_id = p_user_id;
  select coalesce(array_agg(s.store_key order by s.store_key), array[]::text[])
    into v_after_stores
  from public.chat_user_stores s
  where s.user_id = p_user_id;
  select coalesce(array_agg(m.group_id order by m.group_id)
                  filter (where m.can_manage), array[]::bigint[])
    into v_after_managed_rooms
  from public.chat_group_members m
  join public.chat_groups g on g.id = m.group_id
  where m.user_id = p_user_id
    and coalesce(g.is_direct, false) = false;

  insert into public.chat_admin_audit_log (
    action, target_user_id, actor, before_state, after_state
  ) values (
    case when p_enabled then 'full_admin_grant' else 'full_admin_revoke' end,
    p_user_id,
    v_actor,
    jsonb_build_object(
      'access', to_jsonb(v_before),
      'store_keys', to_jsonb(v_before_stores),
      'managed_shared_group_ids', to_jsonb(v_before_managed_rooms)
    ),
    jsonb_build_object(
      'access', to_jsonb(v_after),
      'store_keys', to_jsonb(v_after_stores),
      'managed_shared_group_ids', to_jsonb(v_after_managed_rooms),
      'direct_rooms_modified', false
    )
  );

  return v_after;
end;
$fn$;

revoke all on function public.chat_admin_set_full_admin(
  uuid, boolean, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.chat_admin_set_full_admin(
  uuid, boolean, timestamptz, text
) to service_role;

select public.chat_ensure_manager_notice_room();
