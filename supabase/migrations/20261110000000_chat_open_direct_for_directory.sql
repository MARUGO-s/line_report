-- 「同僚を探す」専用の全店舗1対1開始処理。
-- 通常の chat_open_direct と転送・招待経路は、引き続き同店舗判定を使う。

create or replace function public.chat_open_direct_core(
  p_other uuid,
  p_require_shared_store boolean
)
returns bigint
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_me uuid := auth.uid();
  v_key text;
  v_id bigint;
  v_name text;
begin
  if v_me is null or not public.chat_is_registered() then
    raise exception 'ログインが必要です';
  end if;
  if not exists (
    select 1 from public.chat_user_access a
    where a.user_id = v_me and a.can_start_direct
  ) then
    raise exception '1対1トークを開始する権限がありません';
  end if;
  if p_other is null or p_other = v_me then
    raise exception '自分以外のユーザーを選んでください';
  end if;
  if not public.chat_has_active_access(p_other) then
    raise exception '相手のユーザーは現在利用できません';
  end if;
  if p_require_shared_store is null then
    raise exception '店舗範囲を確認できません';
  end if;

  if v_me::text < p_other::text then
    v_key := v_me::text || ':' || p_other::text;
  else
    v_key := p_other::text || ':' || v_me::text;
  end if;

  select id into v_id
  from public.chat_groups
  where direct_key = v_key and is_direct;

  if v_id is null then
    if p_require_shared_store
      and not public.chat_shares_affiliation(v_me, p_other) then
      raise exception '1対1トークは所属店舗が同じ相手だけ始められます';
    end if;
    select string_agg(username, '・' order by username) into v_name
    from public.chat_users where id in (v_me, p_other);

    insert into public.chat_groups (group_name, created_by, is_direct, direct_key)
    values (coalesce(v_name, '友だち'), v_me, true, v_key)
    returning id into v_id;
  elsif exists (
    select 1 from public.chat_group_members
    where group_id = v_id and user_id not in (v_me, p_other)
  ) then
    raise exception '1対1トークの参加者が不正です';
  end if;

  insert into public.chat_group_members (
    group_id, user_id, can_view, can_send, can_invite, can_manage
  ) values
    (v_id, v_me, true, true, false, false),
    (v_id, p_other, true, true, false, false)
  on conflict (group_id, user_id) do nothing;

  if exists (
    select 1 from public.chat_group_members
    where group_id = v_id
      and user_id in (v_me, p_other)
      and not can_view
  ) then
    raise exception 'この1対1トークへのアクセスは制限されています';
  end if;
  if (select count(*) from public.chat_group_members where group_id = v_id) <> 2 then
    raise exception '1対1トークには2人だけ参加できます';
  end if;

  return v_id;
end;
$fn$;

-- 既存RPCの同店舗制約をそのまま維持する。
create or replace function public.chat_open_direct(p_other uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $fn$
begin
  return public.chat_open_direct_core(p_other, true);
end;
$fn$;

-- 全店舗検索からの1対1だけを許可する専用RPC。
create or replace function public.chat_open_direct_for_directory(p_other uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null or not public.chat_is_registered() then
    raise exception 'ログインが必要です';
  end if;
  if not public.chat_can_browse_users() then
    raise exception '登録ユーザーを参照する権限がありません';
  end if;
  if p_other is null or p_other = v_me then
    raise exception '自分以外のユーザーを選んでください';
  end if;
  if not exists (
    select 1 from public.chat_users u
    where u.id = p_other
      and coalesce(u.is_bot, false) = false
      and u.bot_deleted_at is null
  ) then
    raise exception '同僚ユーザーは現在利用できません';
  end if;

  return public.chat_open_direct_core(p_other, false);
end;
$fn$;

revoke all on function public.chat_open_direct_core(uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.chat_open_direct_for_directory(uuid)
  from public, anon, service_role;
grant execute on function public.chat_open_direct_for_directory(uuid)
  to authenticated;

comment on function public.chat_open_direct_for_directory(uuid) is
  '全店舗の同僚検索専用。閲覧・1対1開始権限と利用中の人間アカウントを検証し、既存の直接ルームを再利用する。';