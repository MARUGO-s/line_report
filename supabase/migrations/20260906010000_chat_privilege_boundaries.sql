-- 権限境界の締め直し。
-- 1) メンバー行の既定を閲覧のみにする（列を省略した INSERT が送信・招待にならない）。
-- 2) プロフィール作成は RPC のみ（ブラウザからの chat_users INSERT を禁止）。
-- 3) 店舗ルームへの招待参加は所属店舗だけ。
-- 4) 承認前ユーザーをルームから外す。

alter table public.chat_group_members
  alter column can_send set default false,
  alter column can_invite set default false,
  alter column can_manage set default false;

comment on column public.chat_group_members.can_send is
  'この参加者が通常投稿・画像・リアクション・予約送信を行える。既定は false（閲覧のみ）。';
comment on column public.chat_group_members.can_invite is
  'この参加者が通常ルームへ他ユーザーを招待できる。既定は false。1対1は常に false。';

drop policy if exists chat_users_insert_self on public.chat_users;
revoke insert on table public.chat_users from public, anon, authenticated;

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

  if v_store is not null then
    if v_bot then
      return v_bot_store is not distinct from v_store;
    end if;
    return exists (
      select 1 from public.chat_user_stores s
      where s.user_id = p_user_id and s.store_key = v_store
    );
  end if;

  if v_bot then
    return public.chat_shares_affiliation(auth.uid(), p_user_id);
  end if;
  if auth.uid() is null or auth.uid() = p_user_id then
    -- 招待リンク参加など、所属店舗のない通常ルーム。
    return true;
  end if;
  return public.chat_shares_affiliation(auth.uid(), p_user_id);
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

  if not public.chat_user_can_join_group_by_store(v_group_id, auth.uid()) then
    raise exception 'このルームの所属店舗ではないため参加できません';
  end if;

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

-- 承認待ちの人間ユーザーはどのルームにも入れない。
delete from public.chat_group_members m
using public.chat_user_access a
join public.chat_users u on u.id = a.user_id
where m.user_id = a.user_id
  and coalesce(u.is_bot, false) = false
  and a.signup_status = 'pending';
