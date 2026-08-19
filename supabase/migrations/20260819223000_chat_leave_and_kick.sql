-- ルームからの退出と、作成者による退出させる。

create or replace function public.chat_leave_group(p_group_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null then
    raise exception 'ログインしてください';
  end if;
  if not public.chat_is_member(p_group_id) then
    raise exception 'このルームに参加していません';
  end if;

  delete from public.chat_group_members
  where group_id = p_group_id
    and user_id = auth.uid();
end;
$fn$;

create or replace function public.chat_kick_member(p_group_id bigint, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_owner uuid;
  v_direct boolean;
begin
  if auth.uid() is null then
    raise exception 'ログインしてください';
  end if;
  if p_user_id is null then
    raise exception '退出させる相手が指定されていません';
  end if;
  if p_user_id = auth.uid() then
    raise exception '自分を退出させることはできません。ルームを退出してください';
  end if;
  if p_user_id = '00000000-0000-4000-8000-00000000b071'::uuid then
    raise exception 'このアカウントは退出させられません';
  end if;

  select created_by, coalesce(is_direct, false)
    into v_owner, v_direct
  from public.chat_groups
  where id = p_group_id;

  if v_owner is null then
    raise exception 'ルームが見つかりません';
  end if;
  if v_direct then
    raise exception '1対1トークから退出させることはできません';
  end if;
  if v_owner is distinct from auth.uid() then
    raise exception '退出させる権限がありません';
  end if;
  if not exists (
    select 1 from public.chat_group_members
    where group_id = p_group_id and user_id = p_user_id
  ) then
    raise exception 'このユーザーは参加していません';
  end if;

  delete from public.chat_group_members
  where group_id = p_group_id
    and user_id = p_user_id;
end;
$fn$;

revoke all on function public.chat_leave_group(bigint) from public, anon;
revoke all on function public.chat_kick_member(bigint, uuid) from public, anon;
grant execute on function public.chat_leave_group(bigint) to authenticated;
grant execute on function public.chat_kick_member(bigint, uuid) to authenticated;

comment on function public.chat_leave_group(bigint) is
  'ログイン中ユーザーがルームから退出する。';
comment on function public.chat_kick_member(bigint, uuid) is
  'ルーム作成者が他の参加者を退出させる。';
