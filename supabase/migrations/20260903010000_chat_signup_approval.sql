-- 新規登録はすぐ使えず、ルーム管理権限を持つ人の許可が必要。
-- 許可された時点では閲覧のみ。送信・招待・グループ作成・1対1開始は後から付ける。
-- 既存ユーザーは signup_status=approved / default_can_send=true のまま。

alter table public.chat_user_access
  add column if not exists signup_status text not null default 'approved',
  add column if not exists default_can_send boolean not null default true;

alter table public.chat_user_access
  drop constraint if exists chat_user_access_signup_status_check;
alter table public.chat_user_access
  add constraint chat_user_access_signup_status_check
  check (signup_status in ('pending', 'approved', 'denied'));

comment on column public.chat_user_access.signup_status is
  'pending=新規登録の承認待ち。approved=利用可。denied=不許可。既存行は approved。';
comment on column public.chat_user_access.default_can_send is
  'trueなら以後のグループ参加で送信・招待も付く。falseなら閲覧のみで参加する。';

-- ---------------------------------------------------------------------------
-- 参加時の既定権限（閲覧のみスタート）
-- ---------------------------------------------------------------------------

create or replace function public.chat_new_member_permissions(p_user_id uuid)
returns table (
  can_view boolean,
  can_send boolean,
  can_invite boolean,
  can_manage boolean
)
language sql
stable
security definer
set search_path = public
as $fn$
  select
    true,
    coalesce(a.default_can_send, true),
    coalesce(a.default_can_send, true),
    false
  from (select p_user_id as user_id) src
  left join public.chat_user_access a on a.user_id = src.user_id
$fn$;

comment on function public.chat_new_member_permissions(uuid) is
  'グループへ新規参加するときの4権限。default_can_send=falseなら閲覧のみ。';

revoke all on function public.chat_new_member_permissions(uuid)
  from public, anon, authenticated;
grant execute on function public.chat_new_member_permissions(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 管理者カード投稿の内部ディスパッチ
-- ---------------------------------------------------------------------------

create or replace function public.chat_enqueue_signup_dispatch(
  p_action text,
  p_body jsonb
)
returns void
language plpgsql
security definer
set search_path = public, net, pg_catalog
as $fn$
declare
  v_secret text;
  v_action text := lower(btrim(coalesce(p_action, '')));
begin
  if v_action not in ('signup-notify', 'signup-reviewed') then
    return;
  end if;

  select dispatch_secret into v_secret
  from public.chat_push_internal_config
  where id = true;
  if v_secret is null or v_secret = '' then
    return;
  end if;

  perform net.http_post(
    url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/chat-knowledge?action=' || v_action,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_secret,
      'Content-Type', 'application/json'
    ),
    body := coalesce(p_body, '{}'::jsonb),
    timeout_milliseconds := 60000
  );
exception
  when others then
    null;
end;
$fn$;

revoke all on function public.chat_enqueue_signup_dispatch(text, jsonb)
  from public, anon, authenticated;
grant execute on function public.chat_enqueue_signup_dispatch(text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 新規 chat_users は承認待ち。Botは従来どおり有効。
-- ---------------------------------------------------------------------------

create or replace function public.chat_create_default_user_access()
returns trigger
language plpgsql
security definer
set search_path = public, net, pg_catalog
as $fn$
begin
  if coalesce(new.is_bot, false) then
    insert into public.chat_user_access (
      user_id, access_enabled, can_start_direct, can_create_group, can_browse_users,
      default_can_send, signup_status, restriction_reason
    ) values (
      new.id, true, true, true, true, true, 'approved', null
    )
    on conflict (user_id) do nothing;
    return new;
  end if;

  insert into public.chat_user_access (
    user_id, access_enabled, can_start_direct, can_create_group, can_browse_users,
    default_can_send, signup_status, restriction_reason
  ) values (
    new.id, false, false, false, false, false, 'pending', '管理者の承認待ち'
  )
  on conflict (user_id) do nothing;

  perform public.chat_enqueue_signup_dispatch(
    'signup-notify',
    jsonb_build_object(
      'user_id', new.id,
      'username', new.username
    )
  );
  return new;
end;
$fn$;

drop trigger if exists chat_users_create_default_access on public.chat_users;
create trigger chat_users_create_default_access
after insert on public.chat_users
for each row execute function public.chat_create_default_user_access();

revoke all on function public.chat_create_default_user_access() from public, anon, authenticated;

-- 管理画面から access_enabled=true にしたら承認済みへ揃える。
create or replace function public.chat_user_access_sync_signup_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.access_enabled is true
    and coalesce(old.signup_status, 'approved') in ('pending', 'denied')
  then
    new.signup_status := 'approved';
    if new.restriction_reason in (
      '管理者の承認待ち',
      '管理者により利用が許可されませんでした'
    ) then
      new.restriction_reason := null;
    end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists chat_user_access_sync_signup_status on public.chat_user_access;
create trigger chat_user_access_sync_signup_status
before update on public.chat_user_access
for each row execute function public.chat_user_access_sync_signup_status();

revoke all on function public.chat_user_access_sync_signup_status()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 許可 / 不許可 RPC（ルーム管理権限を持つ人だけ）
-- ---------------------------------------------------------------------------

create or replace function public.chat_is_signup_manager(
  p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select public.chat_has_active_access(p_user_id) and exists (
    select 1
    from public.chat_group_members gm
    join public.chat_groups g on g.id = gm.group_id
    join public.chat_users u on u.id = gm.user_id
    where gm.user_id = p_user_id
      and gm.can_view = true
      and gm.can_manage = true
      and not coalesce(g.is_direct, false)
      and g.trashed_at is null
      and coalesce(u.is_bot, false) = false
  )
$fn$;

revoke all on function public.chat_is_signup_manager(uuid) from public, anon;
grant execute on function public.chat_is_signup_manager(uuid) to authenticated, service_role;

create or replace function public.chat_review_signup(
  p_user_id uuid,
  p_approve boolean
)
returns public.chat_user_access
language plpgsql
security definer
set search_path = public, net, pg_catalog
as $fn$
declare
  v_me uuid := auth.uid();
  v_before public.chat_user_access;
  v_after public.chat_user_access;
  v_username text;
  v_is_bot boolean;
  v_reviewer_name text;
begin
  if v_me is null or not public.chat_is_signup_manager(v_me) then
    raise exception 'この操作はルームの管理権限が必要です';
  end if;
  if p_user_id is null then
    raise exception '対象のユーザーを指定してください';
  end if;
  if p_user_id = v_me then
    raise exception '自分の登録は承認できません';
  end if;

  select username, coalesce(is_bot, false)
    into v_username, v_is_bot
  from public.chat_users
  where id = p_user_id;
  if not found then raise exception 'ユーザーが見つかりません'; end if;
  if v_is_bot then raise exception 'Botの登録は承認対象ではありません'; end if;

  select * into v_before
  from public.chat_user_access
  where user_id = p_user_id
  for update;
  if not found then
    raise exception '利用設定が見つかりません';
  end if;
  if v_before.deleted_at is not null then
    raise exception '削除済みユーザーは承認できません';
  end if;
  if coalesce(v_before.signup_status, 'approved') is distinct from 'pending' then
    raise exception 'この登録はすでに処理されています';
  end if;

  if coalesce(p_approve, false) then
    update public.chat_user_access
    set access_enabled = true,
        can_start_direct = false,
        can_create_group = false,
        can_browse_users = false,
        default_can_send = false,
        signup_status = 'approved',
        restriction_reason = null,
        restricted_until = null,
        updated_at = clock_timestamp(),
        updated_by = v_me::text
    where user_id = p_user_id
    returning * into v_after;
  else
    update public.chat_user_access
    set access_enabled = false,
        can_start_direct = false,
        can_create_group = false,
        can_browse_users = false,
        default_can_send = false,
        signup_status = 'denied',
        restriction_reason = '管理者により利用が許可されませんでした',
        restricted_until = null,
        updated_at = clock_timestamp(),
        updated_by = v_me::text
    where user_id = p_user_id
    returning * into v_after;
  end if;

  select username into v_reviewer_name
  from public.chat_users
  where id = v_me;

  perform public.chat_enqueue_signup_dispatch(
    'signup-reviewed',
    jsonb_build_object(
      'user_id', p_user_id,
      'username', v_username,
      'approved', coalesce(p_approve, false),
      'reviewer_id', v_me,
      'reviewer_name', v_reviewer_name
    )
  );

  return v_after;
end;
$fn$;

revoke all on function public.chat_review_signup(uuid, boolean) from public, anon;
grant execute on function public.chat_review_signup(uuid, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- グループ作成・追加・招待参加は default_can_send に従う
-- ---------------------------------------------------------------------------

create or replace function public.chat_create_group(
  p_group_name text,
  p_member_ids uuid[] default '{}'
)
returns bigint
language plpgsql
security definer
set search_path = public
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
  );

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

create or replace function public.chat_join_by_invite(p_token text)
returns bigint
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_group_id bigint;
  v_existing boolean;
begin
  if auth.uid() is null or not public.chat_is_registered() then
    raise exception 'ログインが必要です';
  end if;
  select i.group_id into v_group_id
  from public.chat_group_invites i
  join public.chat_groups g on g.id = i.group_id and not g.is_direct
  where i.token = p_token;
  if v_group_id is null then raise exception '招待リンクが無効です'; end if;

  select exists (
    select 1 from public.chat_group_members
    where group_id = v_group_id and user_id = auth.uid()
  ) into v_existing;
  if v_existing then
    if not exists (
      select 1 from public.chat_group_members
      where group_id = v_group_id and user_id = auth.uid() and can_view
    ) then
      raise exception 'このルームへのアクセスは制限されています';
    end if;
    return v_group_id;
  end if;

  insert into public.chat_group_members (
    group_id, user_id, can_view, can_send, can_invite, can_manage
  )
  select v_group_id, auth.uid(), perms.can_view, perms.can_send, perms.can_invite, perms.can_manage
  from public.chat_new_member_permissions(auth.uid()) perms;
  return v_group_id;
end;
$fn$;
