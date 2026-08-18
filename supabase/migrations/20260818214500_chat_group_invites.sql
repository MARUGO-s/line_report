-- LINE のようなグループ招待。
-- 招待リンクはメンバーだけが見られ、参加は security definer 経由。

create extension if not exists pgcrypto;

create table if not exists public.chat_group_invites (
  token text primary key default encode(gen_random_bytes(16), 'hex'),
  group_id bigint not null unique references public.chat_groups(id) on delete cascade,
  created_by uuid not null references public.chat_users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.chat_group_invites enable row level security;

drop policy if exists chat_group_invites_member_all on public.chat_group_invites;
create policy chat_group_invites_member_all on public.chat_group_invites
  for all to authenticated
  using (public.chat_is_member(group_id))
  with check (public.chat_is_member(group_id));

-- 招待するために、登録済みユーザー同士は表示名とアイコンだけ見える。
drop policy if exists chat_users_select_registered on public.chat_users;
create policy chat_users_select_registered on public.chat_users
  for select to authenticated
  using (public.chat_is_registered());

-- メンバーが他のユーザーをグループへ入れる。
drop policy if exists chat_group_members_insert_by_member on public.chat_group_members;
create policy chat_group_members_insert_by_member on public.chat_group_members
  for insert to authenticated
  with check (public.chat_is_member(group_id) and public.chat_is_registered());

create or replace function public.chat_ensure_invite(p_group_id bigint)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_token text;
begin
  if auth.uid() is null or not public.chat_is_member(p_group_id) then
    raise exception 'このグループを招待する権限がありません';
  end if;

  select token into v_token
  from public.chat_group_invites
  where group_id = p_group_id;

  if v_token is null then
    insert into public.chat_group_invites (group_id, created_by)
    values (p_group_id, auth.uid())
    returning token into v_token;
  end if;

  return v_token;
end;
$fn$;

create or replace function public.chat_rotate_invite(p_group_id bigint)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null or not public.chat_is_member(p_group_id) then
    raise exception 'このグループを招待する権限がありません';
  end if;

  delete from public.chat_group_invites where group_id = p_group_id;
  return public.chat_ensure_invite(p_group_id);
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
begin
  if auth.uid() is null then
    raise exception 'ログインが必要です';
  end if;

  if not exists (select 1 from public.chat_users where id = auth.uid()) then
    raise exception '先に表示名を登録してください';
  end if;

  select group_id into v_group_id
  from public.chat_group_invites
  where token = p_token;

  if v_group_id is null then
    raise exception '招待リンクが無効です';
  end if;

  insert into public.chat_group_members (group_id, user_id)
  values (v_group_id, auth.uid())
  on conflict (group_id, user_id) do nothing;

  return v_group_id;
end;
$fn$;

revoke all on function public.chat_ensure_invite(bigint) from public, anon;
revoke all on function public.chat_rotate_invite(bigint) from public, anon;
revoke all on function public.chat_join_by_invite(text) from public, anon;
grant execute on function public.chat_ensure_invite(bigint) to authenticated;
grant execute on function public.chat_rotate_invite(bigint) to authenticated;
grant execute on function public.chat_join_by_invite(text) to authenticated;
