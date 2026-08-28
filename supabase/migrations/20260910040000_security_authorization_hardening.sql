-- Security hardening:
-- 1. Internal cron token resolution no longer falls back to the public anon key.
-- 2. M-talk Journal AI requires an explicit headquarters-granted user permission.
-- 3. Signup/store-change approval is no longer implied by ordinary room management.
-- 4. Browser-facing RLS policies and extension/index advisor warnings are tightened.

create or replace function public.resolve_edge_cron_auth_token()
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
declare
  v_token text;
begin
  v_token := nullif(btrim(current_setting('custom.cron_auth_token', true)), '');
  if v_token is not null then
    return v_token;
  end if;

  begin
    select nullif(btrim(decrypted_secret), '')
      into v_token
    from vault.decrypted_secrets
    where name = 'CRON_AUTH_TOKEN'
    order by created_at desc
    limit 1;
  exception
    when invalid_schema_name or undefined_table or insufficient_privilege then
      v_token := null;
  end;

  -- Never use SUPABASE_ANON_KEY as an internal secret. It is intentionally
  -- public in browser clients and cannot authenticate a privileged cron.
  return v_token;
end;
$fn$;

revoke all on function public.resolve_edge_cron_auth_token() from public, anon, authenticated;
grant execute on function public.resolve_edge_cron_auth_token() to postgres, service_role;

alter table public.chat_user_access
  add column if not exists can_use_journal_ai boolean not null default false,
  add column if not exists can_review_access boolean not null default false;

comment on column public.chat_user_access.can_use_journal_ai is
  'Headquarters-granted permission to open the store-scoped M-talk Journal AI surface.';
comment on column public.chat_user_access.can_review_access is
  'Headquarters-granted global permission to approve M-talk signups and store changes.';

-- A room creator is a manager of that room, but that must never make the person
-- a global signup/store-affiliation administrator. Only the explicit HQ flag does.
create or replace function public.chat_is_signup_manager(
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
      and a.can_review_access = true
      and a.access_enabled = true
      and a.deleted_at is null
      and (a.restricted_until is null or a.restricted_until <= now())
      and coalesce(u.is_bot, false) = false
  )
$fn$;

revoke all on function public.chat_is_signup_manager(uuid)
  from public, anon, authenticated;
grant execute on function public.chat_is_signup_manager(uuid)
  to postgres, service_role;

-- Notice visibility is tied to the explicit reviewer flag as well as membership.
-- Binding p_user_id prevents a caller from asking the function about somebody else.
create or replace function public.chat_can_see_admin_notice(
  p_group_id bigint,
  p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $fn$
  select (
    p_user_id = auth.uid()
    or (select auth.role()) = 'service_role'
  )
  and public.chat_is_signup_manager(p_user_id)
  and exists (
    select 1
    from public.chat_group_members gm
    join public.chat_groups g on g.id = gm.group_id
    where gm.group_id = p_group_id
      and gm.user_id = p_user_id
      and gm.can_view = true
      and g.trashed_at is null
  )
$fn$;

revoke all on function public.chat_can_see_admin_notice(bigint, uuid)
  from public, anon;
grant execute on function public.chat_can_see_admin_notice(bigint, uuid)
  to authenticated, service_role;

-- Keep the dedicated notice room synchronized only with explicitly appointed
-- reviewers. They can act on review cards, but do not get room-management rights.
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
        can_invite = false,
        can_manage = false;

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

-- Self profile updates may change only user-facing profile fields. System/Bot
-- state is restored from OLD even when a client submits those columns directly.
create or replace function public.chat_users_protect_bot_fields()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      new.is_bot := false;
      new.store_key := null;
      new.bot_deleted_at := null;
      new.bot_deleted_by := null;
    else
      new.id := old.id;
      new.created_at := old.created_at;
      new.is_bot := old.is_bot;
      new.store_key := old.store_key;
      new.bot_deleted_at := old.bot_deleted_at;
      new.bot_deleted_by := old.bot_deleted_by;
    end if;
  end if;
  return new;
end;
$fn$;

revoke all on function public.chat_users_protect_bot_fields()
  from public, anon, authenticated;
grant execute on function public.chat_users_protect_bot_fields()
  to postgres, service_role;

drop function if exists public.chat_admin_update_user_access_secure(
  uuid, boolean, boolean, boolean, boolean, boolean, text, timestamptz,
  boolean, boolean, timestamptz, text
);

create or replace function public.chat_admin_update_user_access_secure(
  p_user_id uuid,
  p_access_enabled boolean,
  p_can_start_direct boolean,
  p_can_create_group boolean,
  p_can_browse_users boolean,
  p_can_use_journal_ai boolean,
  p_can_review_access boolean,
  p_restriction_reason text,
  p_restricted_until timestamptz,
  p_update_restriction_reason boolean,
  p_update_restricted_until boolean,
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
begin
  select is_bot into v_is_bot from public.chat_users where id = p_user_id;
  if not found then raise exception 'ユーザーが見つかりません'; end if;
  if v_is_bot then raise exception 'Botの利用を停止・変更することはできません'; end if;

  insert into public.chat_user_access (user_id) values (p_user_id)
  on conflict (user_id) do nothing;
  select * into v_before from public.chat_user_access
  where user_id = p_user_id for update;
  if v_before.deleted_at is not null then
    raise exception '削除済みユーザーは復元操作を使用してください';
  end if;
  if p_expected_updated_at is null
    or v_before.updated_at is distinct from p_expected_updated_at
  then
    raise exception using
      errcode = '40001',
      message = '別の管理者が先に更新しました。再読み込みしてください';
  end if;

  update public.chat_user_access
  set access_enabled = coalesce(p_access_enabled, access_enabled),
      can_start_direct = coalesce(p_can_start_direct, can_start_direct),
      can_create_group = coalesce(p_can_create_group, can_create_group),
      can_browse_users = coalesce(p_can_browse_users, can_browse_users),
      can_use_journal_ai = coalesce(p_can_use_journal_ai, can_use_journal_ai),
      can_review_access = coalesce(p_can_review_access, can_review_access),
      restriction_reason = case
        when p_update_restriction_reason then nullif(btrim(coalesce(p_restriction_reason, '')), '')
        else restriction_reason
      end,
      restricted_until = case
        when p_update_restricted_until then p_restricted_until
        else restricted_until
      end,
      updated_at = clock_timestamp(),
      updated_by = v_actor
  where user_id = p_user_id
  returning * into v_after;

  insert into public.chat_admin_audit_log (
    action, target_user_id, actor, before_state, after_state
  ) values (
    'user_sensitive_access_update', p_user_id, v_actor,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  -- Grant/revoke immediately updates the private review-notice room in the same
  -- transaction, so a revoked reviewer cannot retain visibility even briefly.
  if p_can_review_access is not null then
    perform public.chat_ensure_manager_notice_room();
  end if;
  return v_after;
end;
$fn$;

revoke all on function public.chat_admin_update_user_access_secure(
  uuid, boolean, boolean, boolean, boolean, boolean, boolean, text, timestamptz,
  boolean, boolean, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.chat_admin_update_user_access_secure(
  uuid, boolean, boolean, boolean, boolean, boolean, boolean, text, timestamptz,
  boolean, boolean, timestamptz, text
) to service_role;

-- Performance advisor fixes that do not broaden access.
drop policy if exists "Service role line_file_templates" on public.line_file_templates;
create policy "Service role line_file_templates"
  on public.line_file_templates
  for all
  to public
  using ((select auth.role()) = 'service_role')
  with check ((select auth.role()) = 'service_role');

drop policy if exists chat_users_select_self on public.chat_users;
drop policy if exists chat_users_select_registered on public.chat_users;
create policy chat_users_select_visible
  on public.chat_users
  for select
  to authenticated
  using (
    id = (select auth.uid())
    or public.chat_can_see_directory_user(id)
  );

drop index if exists public.idx_foodcourt_daily_logs_store_date;

do $fn$
begin
  if exists (
    select 1
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pg_trgm' and n.nspname = 'public'
  ) then
    execute 'alter extension pg_trgm set schema extensions';
  end if;
end;
$fn$;
