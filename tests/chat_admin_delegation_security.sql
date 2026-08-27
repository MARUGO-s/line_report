\set ON_ERROR_STOP on

begin;

-- Test-only users are inserted with application triggers disabled. Everything in
-- this file is rolled back, including the delegation and audit records.
set local session_replication_role = replica;

insert into public.chat_users (id, username, is_bot)
values
  ('d1111111-1111-4111-8111-111111111111', '__delegation_security_user_a__', false),
  ('d2222222-2222-4222-8222-222222222222', '__delegation_security_user_b__', false);

insert into public.chat_user_stores (user_id, store_key)
values
  ('d1111111-1111-4111-8111-111111111111', 'claudia2'),
  ('d2222222-2222-4222-8222-222222222222', 'bistrocavacava');

insert into public.chat_group_members (
  group_id, user_id, can_view, can_send, can_invite, can_manage
)
select id, 'd1111111-1111-4111-8111-111111111111', true, false, false, false
from public.chat_groups
where store_key = 'claudia2' and is_store_room
limit 1;

insert into public.chat_group_members (
  group_id, user_id, can_view, can_send, can_invite, can_manage
)
select id, 'd2222222-2222-4222-8222-222222222222', true, false, false, false
from public.chat_groups
where store_key = 'bistrocavacava' and is_store_room
limit 1;

set local session_replication_role = origin;

do $test$
declare
  v_delegation_id uuid;
  v_expired_id uuid;
  v_allowed_group_id bigint;
  v_denied_group_id bigint;
  v_allowed_bot_id uuid;
  v_denied_bot_id uuid;
  v_allowed_audit_id bigint;
  v_denied_audit_id bigint;
  v_denied boolean;
  v_can_send boolean;
  v_session_version bigint;
begin
  select id into strict v_allowed_group_id
  from public.chat_groups
  where store_key = 'claudia2' and is_store_room
  limit 1;

  select id into strict v_denied_group_id
  from public.chat_groups
  where store_key = 'bistrocavacava' and is_store_room
  limit 1;

  select id into strict v_allowed_bot_id
  from public.chat_users
  where is_bot and store_key = 'claudia2'
  limit 1;

  select id into strict v_denied_bot_id
  from public.chat_users
  where is_bot and store_key = 'bistrocavacava'
  limit 1;

  insert into public.chat_admin_delegations (
    label, scope_mode, store_keys, capabilities, expires_at, created_by, updated_by
  ) values (
    'DB security test',
    'stores',
    array['claudia2'],
    array['view', 'audit_read', 'manage_members', 'manage_rooms', 'manage_bots', 'revert_audit'],
    now() + interval '1 hour',
    'db-security-test',
    'db-security-test'
  ) returning id into v_delegation_id;

  select session_version into strict v_session_version
  from public.chat_admin_delegations
  where id = v_delegation_id;
  if v_session_version <> 1 then
    raise exception 'delegation session version did not start at 1';
  end if;

  if not public.chat_admin_delegation_allows_room(
    v_delegation_id, v_allowed_group_id, 'manage_members'
  ) then
    raise exception 'allowed room was rejected';
  end if;

  if public.chat_admin_delegation_allows_room(
    v_delegation_id, v_denied_group_id, 'manage_members'
  ) then
    raise exception 'cross-store room was allowed';
  end if;

  if not public.chat_admin_delegation_allows_user_read(
    v_delegation_id, 'd1111111-1111-4111-8111-111111111111'
  ) then
    raise exception 'allowed-store user was rejected';
  end if;

  if public.chat_admin_delegation_allows_user_read(
    v_delegation_id, 'd2222222-2222-4222-8222-222222222222'
  ) then
    raise exception 'cross-store user was visible';
  end if;

  if not public.chat_admin_delegation_allows_bot(
    v_delegation_id, v_allowed_bot_id, 'manage_bots'
  ) then
    raise exception 'allowed-store bot was rejected';
  end if;

  if public.chat_admin_delegation_allows_bot(
    v_delegation_id, v_denied_bot_id, 'manage_bots'
  ) then
    raise exception 'cross-store bot was allowed';
  end if;

  perform public.chat_admin_delegated_execute(
    v_delegation_id,
    'update_member',
    jsonb_build_object(
      'p_group_id', v_allowed_group_id,
      'p_user_id', 'd1111111-1111-4111-8111-111111111111',
      'p_can_view', true,
      'p_can_send', true,
      'p_can_invite', false,
      'p_can_manage', false
    ),
    'db-security-test'
  );

  select can_send into strict v_can_send
  from public.chat_group_members
  where group_id = v_allowed_group_id
    and user_id = 'd1111111-1111-4111-8111-111111111111';
  if not v_can_send then
    raise exception 'allowed member update did not run';
  end if;

  v_denied := false;
  begin
    perform public.chat_admin_delegated_execute(
      v_delegation_id,
      'update_member',
      jsonb_build_object(
        'p_group_id', v_denied_group_id,
        'p_user_id', 'd2222222-2222-4222-8222-222222222222',
        'p_can_view', true,
        'p_can_send', true,
        'p_can_invite', false,
        'p_can_manage', false
      ),
      'db-security-test'
    );
  exception when sqlstate '42501' then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'cross-store member update was not denied';
  end if;

  select can_send into strict v_can_send
  from public.chat_group_members
  where group_id = v_denied_group_id
    and user_id = 'd2222222-2222-4222-8222-222222222222';
  if v_can_send then
    raise exception 'cross-store member was mutated';
  end if;

  select max(id) into strict v_allowed_audit_id
  from public.chat_admin_audit_log
  where actor = 'db-security-test'
    and group_id = v_allowed_group_id;

  if not public.chat_admin_delegation_allows_audit(
    v_delegation_id, v_allowed_audit_id, 'revert_audit'
  ) then
    raise exception 'allowed audit record was rejected';
  end if;

  perform public.chat_admin_update_member_permissions(
    v_denied_group_id,
    'd2222222-2222-4222-8222-222222222222',
    true,
    false,
    false,
    false,
    'db-security-test-outside'
  );

  select max(id) into strict v_denied_audit_id
  from public.chat_admin_audit_log
  where actor = 'db-security-test-outside'
    and group_id = v_denied_group_id;

  if public.chat_admin_delegation_allows_audit(
    v_delegation_id, v_denied_audit_id, 'revert_audit'
  ) then
    raise exception 'cross-store audit record was allowed';
  end if;

  v_denied := false;
  begin
    perform public.chat_admin_delegated_execute(
      v_delegation_id,
      'purge_group',
      jsonb_build_object('p_group_id', v_allowed_group_id),
      'db-security-test'
    );
  exception when sqlstate '42501' then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'irreversible room purge was exposed to a delegate';
  end if;

  update public.chat_admin_delegations
  set enabled = false, updated_at = now(), updated_by = 'db-security-test'
  where id = v_delegation_id;

  select session_version into strict v_session_version
  from public.chat_admin_delegations
  where id = v_delegation_id;
  if v_session_version <> 2 then
    raise exception 'security-sensitive update did not advance session version';
  end if;

  v_denied := false;
  begin
    perform public.chat_admin_delegated_execute(
      v_delegation_id,
      'update_member',
      jsonb_build_object(
        'p_group_id', v_allowed_group_id,
        'p_user_id', 'd1111111-1111-4111-8111-111111111111',
        'p_can_view', true,
        'p_can_send', false,
        'p_can_invite', false,
        'p_can_manage', false
      ),
      'db-security-test'
    );
  exception when sqlstate '42501' then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'disabled delegation was still usable';
  end if;

  select can_send into strict v_can_send
  from public.chat_group_members
  where group_id = v_allowed_group_id
    and user_id = 'd1111111-1111-4111-8111-111111111111';
  if not v_can_send then
    raise exception 'disabled delegation changed data';
  end if;

  insert into public.chat_admin_delegations (
    label, scope_mode, store_keys, capabilities,
    created_at, expires_at, created_by, updated_by
  ) values (
    'Expired DB security test',
    'stores',
    array['claudia2'],
    array['view'],
    now() - interval '2 hours',
    now() - interval '1 hour',
    'db-security-test',
    'db-security-test'
  ) returning id into v_expired_id;

  if public.chat_admin_delegation_allows_room(
    v_expired_id, v_allowed_group_id, 'view'
  ) then
    raise exception 'expired delegation was still usable';
  end if;

  v_denied := false;
  begin
    insert into public.chat_admin_delegations (
      label, scope_mode, store_keys, capabilities, expires_at
    ) values (
      'Missing expiry', 'stores', array['claudia2'], array['view'], null
    );
  exception when not_null_violation then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'delegation without expiry was accepted';
  end if;

  v_denied := false;
  begin
    insert into public.chat_admin_delegations (
      label, scope_mode, store_keys, capabilities, expires_at
    ) values (
      'Invalid global capability',
      'stores',
      array['claudia2'],
      array['view', 'manage_users'],
      now() + interval '1 hour'
    );
  exception when check_violation then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'manage_users was accepted for a store scope';
  end if;

  v_denied := false;
  begin
    insert into public.chat_admin_delegations (
      label, scope_mode, room_ids, capabilities, expires_at
    ) values (
      'Invalid room bot capability',
      'rooms',
      array[v_allowed_group_id],
      array['view', 'manage_bots'],
      now() + interval '1 hour'
    );
  exception when check_violation then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'manage_bots was accepted for a room scope';
  end if;

  if has_table_privilege('anon', 'public.chat_admin_delegations', 'select')
    or has_table_privilege('authenticated', 'public.chat_admin_delegations', 'select')
  then
    raise exception 'delegation table is readable by a browser role';
  end if;

  if has_function_privilege(
    'anon',
    'public.chat_admin_delegated_execute(uuid,text,jsonb,text)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.chat_admin_delegated_execute(uuid,text,jsonb,text)',
    'execute'
  ) then
    raise exception 'delegated mutation RPC is executable by a browser role';
  end if;

  if not has_function_privilege(
    'service_role',
    'public.chat_admin_delegated_execute(uuid,text,jsonb,text)',
    'execute'
  ) then
    raise exception 'service_role cannot execute delegated mutation RPC';
  end if;

  raise notice 'chat_admin_delegation_security: all assertions passed';
end;
$test$;

rollback;
