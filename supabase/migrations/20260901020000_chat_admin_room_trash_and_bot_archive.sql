-- M-talk管理画面から、通常ルームを
--   ゴミ箱へ移動 → 復元 / 完全削除
-- の順で操作できるようにする。
--
-- Botは物理削除しない。過去メッセージ・所属履歴を維持したまま論理削除し、
-- 削除済みBot名義の新規投稿をDBトリガで拒否する。
-- どちらの管理RPCもservice_role専用。通常のM-talk利用者には公開しない。

alter table public.chat_users
  add column if not exists bot_deleted_at timestamptz,
  add column if not exists bot_deleted_by text;

comment on column public.chat_users.bot_deleted_at is
  'M-talk管理画面からBotを論理削除した時刻。過去メッセージと所属履歴は保持する。';
comment on column public.chat_users.bot_deleted_by is
  'Botを論理削除したM-talk管理者の監査用ラベル。';

alter table public.chat_users
  drop constraint if exists chat_users_bot_deleted_only_for_bot;
alter table public.chat_users
  add constraint chat_users_bot_deleted_only_for_bot
  check (is_bot or (bot_deleted_at is null and bot_deleted_by is null));

create index if not exists chat_users_active_bot_idx
  on public.chat_users (store_key, id)
  where is_bot and bot_deleted_at is null;

create or replace function public.chat_reject_deleted_bot_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if exists (
    select 1
    from public.chat_users u
    where u.id = new.user_id
      and u.is_bot
      and u.bot_deleted_at is not null
  ) then
    raise exception '削除済みBotからは送信できません';
  end if;
  return new;
end;
$fn$;

drop trigger if exists chat_messages_reject_deleted_bot on public.chat_messages;
create trigger chat_messages_reject_deleted_bot
before insert on public.chat_messages
for each row execute function public.chat_reject_deleted_bot_message();

create or replace function public.chat_admin_trash_group(
  p_group_id bigint,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_before public.chat_groups;
  v_after public.chat_groups;
  v_actor text := left(coalesce(nullif(btrim(p_actor), ''), 'chat-admin'), 200);
begin
  select * into v_before
  from public.chat_groups
  where id = p_group_id
  for update;

  if not found then raise exception 'ルームが見つかりません'; end if;
  if coalesce(v_before.is_store_room, false) then
    raise exception '店舗固定ルームはゴミ箱へ移動できません';
  end if;
  if v_before.trashed_at is not null then
    return to_jsonb(v_before);
  end if;

  perform set_config('chat.allow_trash', '1', true);
  update public.chat_groups
  set trashed_at = now(),
      -- 管理者はchat_usersのUUIDではないため、操作者は監査ログへ記録する。
      trashed_by = null
  where id = p_group_id
    and coalesce(is_store_room, false) = false
  returning * into v_after;

  insert into public.chat_admin_audit_log (
    action, group_id, actor, before_state, after_state
  ) values (
    'room_trash', p_group_id, v_actor, to_jsonb(v_before), to_jsonb(v_after)
  );

  return to_jsonb(v_after);
end;
$fn$;

create or replace function public.chat_admin_restore_group(
  p_group_id bigint,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_before public.chat_groups;
  v_after public.chat_groups;
  v_actor text := left(coalesce(nullif(btrim(p_actor), ''), 'chat-admin'), 200);
begin
  select * into v_before
  from public.chat_groups
  where id = p_group_id
  for update;

  if not found then raise exception 'ルームが見つかりません'; end if;
  if coalesce(v_before.is_store_room, false) then
    raise exception '店舗固定ルームは復元操作の対象ではありません';
  end if;
  if v_before.trashed_at is null then
    return to_jsonb(v_before);
  end if;

  perform set_config('chat.allow_trash', '1', true);
  update public.chat_groups
  set trashed_at = null,
      trashed_by = null
  where id = p_group_id
  returning * into v_after;

  insert into public.chat_admin_audit_log (
    action, group_id, actor, before_state, after_state
  ) values (
    'room_restore', p_group_id, v_actor, to_jsonb(v_before), to_jsonb(v_after)
  );

  return to_jsonb(v_after);
end;
$fn$;

create or replace function public.chat_admin_remove_bot(
  p_user_id uuid,
  p_actor text,
  p_confirm_username text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user_before public.chat_users;
  v_user_after public.chat_users;
  v_access_before public.chat_user_access;
  v_access_after public.chat_user_access;
  v_actor text := left(coalesce(nullif(btrim(p_actor), ''), 'chat-admin'), 200);
begin
  select * into v_user_before
  from public.chat_users
  where id = p_user_id
  for update;

  if not found then raise exception 'Botが見つかりません'; end if;
  if not coalesce(v_user_before.is_bot, false) then
    raise exception 'この操作はBot専用です';
  end if;
  if btrim(coalesce(p_confirm_username, '')) is distinct from v_user_before.username then
    raise exception '確認用のBot名が一致しません';
  end if;
  if v_user_before.bot_deleted_at is not null then
    return jsonb_build_object('user', to_jsonb(v_user_before), 'already_deleted', true);
  end if;

  insert into public.chat_user_access (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select * into v_access_before
  from public.chat_user_access
  where user_id = p_user_id
  for update;

  update public.chat_users
  set bot_deleted_at = now(),
      bot_deleted_by = v_actor
  where id = p_user_id
  returning * into v_user_after;

  update public.chat_user_access
  set access_enabled = false,
      restriction_reason = '管理者によりBotを削除',
      restricted_until = null,
      deleted_at = coalesce(deleted_at, now()),
      updated_at = now(),
      updated_by = v_actor
  where user_id = p_user_id
  returning * into v_access_after;

  insert into public.chat_admin_audit_log (
    action, target_user_id, actor, before_state, after_state
  ) values (
    'bot_remove',
    p_user_id,
    v_actor,
    jsonb_build_object('user', to_jsonb(v_user_before), 'access', to_jsonb(v_access_before)),
    jsonb_build_object('user', to_jsonb(v_user_after), 'access', to_jsonb(v_access_after))
  );

  return jsonb_build_object(
    'user', to_jsonb(v_user_after),
    'access', to_jsonb(v_access_after),
    'history_preserved', true,
    'memberships_preserved', true
  );
end;
$fn$;

create or replace function public.chat_admin_restore_bot(
  p_user_id uuid,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user_before public.chat_users;
  v_user_after public.chat_users;
  v_access_before public.chat_user_access;
  v_access_after public.chat_user_access;
  v_actor text := left(coalesce(nullif(btrim(p_actor), ''), 'chat-admin'), 200);
begin
  select * into v_user_before
  from public.chat_users
  where id = p_user_id
  for update;

  if not found then raise exception 'Botが見つかりません'; end if;
  if not coalesce(v_user_before.is_bot, false) then
    raise exception 'この操作はBot専用です';
  end if;
  if v_user_before.bot_deleted_at is null then
    return jsonb_build_object('user', to_jsonb(v_user_before), 'already_active', true);
  end if;

  insert into public.chat_user_access (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select * into v_access_before
  from public.chat_user_access
  where user_id = p_user_id
  for update;

  update public.chat_users
  set bot_deleted_at = null,
      bot_deleted_by = null
  where id = p_user_id
  returning * into v_user_after;

  update public.chat_user_access
  set access_enabled = true,
      restriction_reason = null,
      restricted_until = null,
      deleted_at = null,
      updated_at = now(),
      updated_by = v_actor
  where user_id = p_user_id
  returning * into v_access_after;

  insert into public.chat_admin_audit_log (
    action, target_user_id, actor, before_state, after_state
  ) values (
    'bot_restore',
    p_user_id,
    v_actor,
    jsonb_build_object('user', to_jsonb(v_user_before), 'access', to_jsonb(v_access_before)),
    jsonb_build_object('user', to_jsonb(v_user_after), 'access', to_jsonb(v_access_after))
  );

  return jsonb_build_object(
    'user', to_jsonb(v_user_after),
    'access', to_jsonb(v_access_after)
  );
end;
$fn$;

revoke all on function public.chat_reject_deleted_bot_message() from public, anon, authenticated;
revoke all on function public.chat_admin_trash_group(bigint, text) from public, anon, authenticated;
revoke all on function public.chat_admin_restore_group(bigint, text) from public, anon, authenticated;
revoke all on function public.chat_admin_remove_bot(uuid, text, text) from public, anon, authenticated;
revoke all on function public.chat_admin_restore_bot(uuid, text) from public, anon, authenticated;

grant execute on function public.chat_admin_trash_group(bigint, text) to service_role;
grant execute on function public.chat_admin_restore_group(bigint, text) to service_role;
grant execute on function public.chat_admin_remove_bot(uuid, text, text) to service_role;
grant execute on function public.chat_admin_restore_bot(uuid, text) to service_role;
