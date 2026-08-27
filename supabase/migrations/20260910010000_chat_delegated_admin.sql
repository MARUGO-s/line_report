-- M-talk 専用の委任管理者。
-- 通常の LINE Report 管理権限とは別の scope とし、対象店舗・対象ルーム・操作能力を
-- DB に保存する。ブラウザには service_role を渡さず、admin-api が毎回この行を再検証する。

create table if not exists public.chat_admin_delegations (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  enabled boolean not null default true,
  scope_mode text not null,
  store_keys text[] not null default '{}'::text[],
  room_ids bigint[] not null default '{}'::bigint[],
  capabilities text[] not null default array['view']::text[],
  expires_at timestamptz not null default (now() + interval '30 days'),
  session_version bigint not null default 1,
  last_link_issued_at timestamptz,
  created_by text not null default 'chat-admin',
  updated_by text not null default 'chat-admin',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_admin_delegations_label_check
    check (char_length(btrim(label)) between 1 and 80),
  constraint chat_admin_delegations_scope_mode_check
    check (scope_mode in ('all', 'stores', 'rooms')),
  constraint chat_admin_delegations_scope_shape_check
    check (
      (scope_mode = 'all' and cardinality(store_keys) = 0 and cardinality(room_ids) = 0)
      or (scope_mode = 'stores' and cardinality(store_keys) between 1 and 50 and cardinality(room_ids) = 0)
      or (scope_mode = 'rooms' and cardinality(room_ids) between 1 and 500 and cardinality(store_keys) = 0)
    ),
  constraint chat_admin_delegations_capabilities_check
    check (
      cardinality(capabilities) between 1 and 8
      and capabilities <@ array[
        'view',
        'audit_read',
        'manage_members',
        'manage_rooms',
        'manage_bots',
        'manage_templates',
        'manage_users',
        'revert_audit'
      ]::text[]
      and 'view' = any(capabilities)
    ),
  constraint chat_admin_delegations_global_user_scope_check
    check (not ('manage_users' = any(capabilities)) or scope_mode = 'all'),
  constraint chat_admin_delegations_bot_scope_check
    check (not ('manage_bots' = any(capabilities)) or scope_mode in ('all', 'stores')),
  constraint chat_admin_delegations_revert_audit_check
    check (not ('revert_audit' = any(capabilities)) or 'audit_read' = any(capabilities)),
  constraint chat_admin_delegations_template_members_check
    check (not ('manage_templates' = any(capabilities)) or 'manage_members' = any(capabilities)),
  constraint chat_admin_delegations_expiry_check
    check (expires_at is null or expires_at > created_at),
  constraint chat_admin_delegations_session_version_check
    check (session_version > 0)
);

comment on table public.chat_admin_delegations is
  'M-talkだけを管理できる委任管理者。通常管理APIとは別scopeで、店舗・ルーム・操作能力を最小付与する。';
comment on column public.chat_admin_delegations.scope_mode is
  'all=M-talk全体、stores=store_keysだけ、rooms=room_idsだけ。';
comment on column public.chat_admin_delegations.capabilities is
  'view/audit_read/manage_members/manage_rooms/manage_bots/manage_templates/manage_users/revert_audit の許可集合。';
comment on column public.chat_admin_delegations.session_version is
  '権限変更・停止・再開ごとに増えるセッション世代。古いリンクとセッションの再利用を拒否する。';

create index if not exists chat_admin_delegations_active_idx
  on public.chat_admin_delegations (enabled, expires_at, updated_at desc);

create or replace function public.chat_admin_bump_delegation_session_version()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if new.enabled is distinct from old.enabled
    or new.scope_mode is distinct from old.scope_mode
    or new.store_keys is distinct from old.store_keys
    or new.room_ids is distinct from old.room_ids
    or new.capabilities is distinct from old.capabilities
    or new.expires_at is distinct from old.expires_at
  then
    new.session_version := old.session_version + 1;
  else
    new.session_version := old.session_version;
  end if;
  return new;
end;
$fn$;

revoke all on function public.chat_admin_bump_delegation_session_version()
  from public, anon, authenticated;

drop trigger if exists chat_admin_delegations_bump_session_version
  on public.chat_admin_delegations;
create trigger chat_admin_delegations_bump_session_version
before update on public.chat_admin_delegations
for each row execute function public.chat_admin_bump_delegation_session_version();

alter table public.chat_admin_delegations enable row level security;
revoke all on table public.chat_admin_delegations from public, anon, authenticated;
grant select, insert, update, delete on table public.chat_admin_delegations to service_role;

drop policy if exists chat_admin_delegations_service_role_all
  on public.chat_admin_delegations;
create policy chat_admin_delegations_service_role_all
  on public.chat_admin_delegations
  for all to service_role
  using ((select auth.jwt()) ->> 'role' = 'service_role')
  with check ((select auth.jwt()) ->> 'role' = 'service_role');

-- admin-api の TypeScript 判定に加え、書込み直前に DB でも対象ルームを検査する。
create or replace function public.chat_admin_delegation_allows_room(
  p_delegation_id uuid,
  p_group_id bigint,
  p_capability text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce((
    select
      d.enabled
      and (d.expires_at is null or d.expires_at > now())
      and p_capability = any(d.capabilities)
      and (
        d.scope_mode = 'all'
        or (d.scope_mode = 'stores' and nullif(btrim(g.store_key), '') = any(d.store_keys))
        or (d.scope_mode = 'rooms' and g.id = any(d.room_ids))
      )
    from public.chat_admin_delegations d
    join public.chat_groups g on g.id = p_group_id
    where d.id = p_delegation_id
  ), false)
$fn$;

create or replace function public.chat_admin_delegation_allows_user_read(
  p_delegation_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce((
    select
      d.enabled
      and (d.expires_at is null or d.expires_at > now())
      and 'view' = any(d.capabilities)
      and (
        d.scope_mode = 'all'
        or (
          d.scope_mode = 'stores'
          and (
            exists (
              select 1 from public.chat_user_stores s
              where s.user_id = p_user_id and s.store_key = any(d.store_keys)
            )
            or exists (
              select 1 from public.chat_users u
              where u.id = p_user_id and u.is_bot and u.store_key = any(d.store_keys)
            )
          )
        )
        or (
          d.scope_mode = 'rooms'
          and exists (
            select 1 from public.chat_group_members m
            where m.user_id = p_user_id and m.group_id = any(d.room_ids)
          )
        )
      )
    from public.chat_admin_delegations d
    where d.id = p_delegation_id
  ), false)
$fn$;

create or replace function public.chat_admin_delegation_allows_user_global(
  p_delegation_id uuid,
  p_user_id uuid,
  p_capability text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce((
    select
      d.enabled
      and (d.expires_at is null or d.expires_at > now())
      and d.scope_mode = 'all'
      and p_capability = any(d.capabilities)
      and exists (select 1 from public.chat_users u where u.id = p_user_id)
    from public.chat_admin_delegations d
    where d.id = p_delegation_id
  ), false)
$fn$;

create or replace function public.chat_admin_delegation_allows_bot(
  p_delegation_id uuid,
  p_user_id uuid,
  p_capability text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce((
    select
      d.enabled
      and (d.expires_at is null or d.expires_at > now())
      and p_capability = any(d.capabilities)
      and u.is_bot
      and (
        d.scope_mode = 'all'
        or (d.scope_mode = 'stores' and nullif(btrim(u.store_key), '') = any(d.store_keys))
      )
    from public.chat_admin_delegations d
    join public.chat_users u on u.id = p_user_id
    where d.id = p_delegation_id
  ), false)
$fn$;

create or replace function public.chat_admin_delegation_allows_audit(
  p_delegation_id uuid,
  p_audit_id bigint,
  p_capability text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce((
    select
      d.enabled
      and (d.expires_at is null or d.expires_at > now())
      and p_capability = any(d.capabilities)
      and case
        when a.action in ('user_access_update', 'user_remove')
          then 'manage_users' = any(d.capabilities)
        when a.action in ('member_permissions_update', 'member_remove')
          then 'manage_members' = any(d.capabilities)
        else false
      end
      and (
        d.scope_mode = 'all'
        or (
          a.group_id is not null
          and (
            (d.scope_mode = 'stores' and nullif(btrim(g.store_key), '') = any(d.store_keys))
            or (d.scope_mode = 'rooms' and a.group_id = any(d.room_ids))
          )
        )
      )
    from public.chat_admin_delegations d
    join public.chat_admin_audit_log a on a.id = p_audit_id
    left join public.chat_groups g on g.id = a.group_id
    where d.id = p_delegation_id
  ), false)
$fn$;

revoke all on function public.chat_admin_delegation_allows_room(uuid, bigint, text)
  from public, anon, authenticated;
revoke all on function public.chat_admin_delegation_allows_user_read(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.chat_admin_delegation_allows_user_global(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.chat_admin_delegation_allows_bot(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.chat_admin_delegation_allows_audit(uuid, bigint, text)
  from public, anon, authenticated;

grant execute on function public.chat_admin_delegation_allows_room(uuid, bigint, text)
  to service_role;
grant execute on function public.chat_admin_delegation_allows_user_read(uuid, uuid)
  to service_role;
grant execute on function public.chat_admin_delegation_allows_user_global(uuid, uuid, text)
  to service_role;
grant execute on function public.chat_admin_delegation_allows_bot(uuid, uuid, text)
  to service_role;
grant execute on function public.chat_admin_delegation_allows_audit(uuid, bigint, text)
  to service_role;

-- 委任の有効性確認と実際の変更を同じトランザクションで行う。
-- 対象行を FOR SHARE で固定するため、停止更新と管理操作が競合した場合は直列化される。
-- 「停止APIが成功して返ったあと」に、停止前の確認を使った変更が滑り込むことはない。
create or replace function public.chat_admin_delegated_execute(
  p_delegation_id uuid,
  p_operation text,
  p_args jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_delegation public.chat_admin_delegations;
  v_args jsonb := coalesce(p_args, '{}'::jsonb);
  v_user_id uuid;
  v_group_id bigint;
  v_audit_id bigint;
  v_group_ids bigint[] := '{}'::bigint[];
  v_user_ids uuid[] := '{}'::uuid[];
begin
  if jsonb_typeof(v_args) is distinct from 'object' then
    raise exception '委任管理操作の引数が不正です';
  end if;

  select * into v_delegation
  from public.chat_admin_delegations
  where id = p_delegation_id
  for share;

  if not found
    or not v_delegation.enabled
    or v_delegation.expires_at <= now()
  then
    raise exception using errcode = '42501', message = 'M-talk管理権限は停止または期限切れです';
  end if;

  if p_operation in ('update_user_access', 'remove_user', 'restore_user') then
    v_user_id := nullif(v_args->>'p_user_id', '')::uuid;
    if not public.chat_admin_delegation_allows_user_global(
      p_delegation_id, v_user_id, 'manage_users'
    ) then
      raise exception using errcode = '42501', message = '全体ユーザー管理の範囲外です';
    end if;

    if p_operation = 'update_user_access' then
      return to_jsonb(public.chat_admin_update_user_access(
        v_user_id,
        nullif(v_args->>'p_access_enabled', '')::boolean,
        nullif(v_args->>'p_can_start_direct', '')::boolean,
        nullif(v_args->>'p_can_create_group', '')::boolean,
        nullif(v_args->>'p_can_browse_users', '')::boolean,
        v_args->>'p_restriction_reason',
        nullif(v_args->>'p_restricted_until', '')::timestamptz,
        coalesce((v_args->>'p_update_restriction_reason')::boolean, false),
        coalesce((v_args->>'p_update_restricted_until')::boolean, false),
        nullif(v_args->>'p_expected_updated_at', '')::timestamptz,
        p_actor
      ));
    elsif p_operation = 'remove_user' then
      return to_jsonb(public.chat_admin_remove_user(
        v_user_id, p_actor, v_args->>'p_confirm_username'
      ));
    else
      return to_jsonb(public.chat_admin_restore_user(v_user_id, p_actor));
    end if;
  end if;

  if p_operation in ('update_member', 'remove_member') then
    v_group_id := nullif(v_args->>'p_group_id', '')::bigint;
    v_user_id := nullif(v_args->>'p_user_id', '')::uuid;
    if not public.chat_admin_delegation_allows_room(
      p_delegation_id, v_group_id, 'manage_members'
    ) then
      raise exception using errcode = '42501', message = 'ルームメンバー管理の範囲外です';
    end if;

    if p_operation = 'update_member' then
      return to_jsonb(public.chat_admin_update_member_permissions(
        v_group_id,
        v_user_id,
        nullif(v_args->>'p_can_view', '')::boolean,
        nullif(v_args->>'p_can_send', '')::boolean,
        nullif(v_args->>'p_can_invite', '')::boolean,
        nullif(v_args->>'p_can_manage', '')::boolean,
        p_actor
      ));
    end if;
    perform public.chat_admin_remove_member(v_group_id, v_user_id, p_actor);
    return jsonb_build_object('ok', true);
  end if;

  if p_operation in ('trash_group', 'restore_group') then
    v_group_id := nullif(v_args->>'p_group_id', '')::bigint;
    if not public.chat_admin_delegation_allows_room(
      p_delegation_id, v_group_id, 'manage_rooms'
    ) then
      raise exception using errcode = '42501', message = 'ルーム管理の範囲外です';
    end if;
    if p_operation = 'trash_group' then
      return public.chat_admin_trash_group(v_group_id, p_actor);
    end if;
    return public.chat_admin_restore_group(v_group_id, p_actor);
  end if;

  if p_operation in ('remove_bot', 'restore_bot') then
    v_user_id := nullif(v_args->>'p_user_id', '')::uuid;
    if not public.chat_admin_delegation_allows_bot(
      p_delegation_id, v_user_id, 'manage_bots'
    ) then
      raise exception using errcode = '42501', message = 'Bot管理の範囲外です';
    end if;
    if p_operation = 'remove_bot' then
      return public.chat_admin_remove_bot(v_user_id, p_actor, v_args->>'p_confirm_username');
    end if;
    return public.chat_admin_restore_bot(v_user_id, p_actor);
  end if;

  if p_operation = 'apply_template' then
    if jsonb_typeof(v_args->'p_group_ids') = 'array' then
      select coalesce(array_agg(value::bigint), '{}'::bigint[])
      into v_group_ids
      from jsonb_array_elements_text(v_args->'p_group_ids');
    end if;
    if jsonb_typeof(v_args->'p_user_ids') = 'array' then
      select coalesce(array_agg(value::uuid), '{}'::uuid[])
      into v_user_ids
      from jsonb_array_elements_text(v_args->'p_user_ids');
    end if;
    if cardinality(v_group_ids) = 0
      or exists (
        select 1 from unnest(v_group_ids) as scoped(group_id)
        where not public.chat_admin_delegation_allows_room(
          p_delegation_id, scoped.group_id, 'manage_templates'
        )
      )
    then
      raise exception using errcode = '42501', message = 'テンプレート適用の範囲外です';
    end if;
    return public.chat_admin_apply_room_template(
      v_group_ids,
      v_user_ids,
      v_args->>'p_template_key',
      coalesce((v_args->>'p_dry_run')::boolean, true),
      p_actor
    );
  end if;

  if p_operation = 'revert_audit' then
    v_audit_id := nullif(v_args->>'p_audit_id', '')::bigint;
    if not public.chat_admin_delegation_allows_audit(
      p_delegation_id, v_audit_id, 'revert_audit'
    ) then
      raise exception using errcode = '42501', message = '監査復元の範囲外です';
    end if;
    return public.chat_admin_revert_audit(
      v_audit_id,
      coalesce((v_args->>'p_dry_run')::boolean, true),
      p_actor
    );
  end if;

  raise exception using errcode = '42501', message = '許可されていないM-talk管理操作です';
end;
$fn$;

comment on function public.chat_admin_delegated_execute(uuid, text, jsonb, text) is
  '委任行をロックし、停止・期限・能力・対象を確認した同一トランザクション内で既存管理RPCを実行する。完全削除は対象外。';

revoke all on function public.chat_admin_delegated_execute(uuid, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.chat_admin_delegated_execute(uuid, text, jsonb, text)
  to service_role;
