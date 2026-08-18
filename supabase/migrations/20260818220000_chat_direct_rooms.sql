-- 友だちタブ用の 1対1 ルーム。

alter table public.chat_groups
  add column if not exists is_direct boolean not null default false;

alter table public.chat_groups
  add column if not exists direct_key text;

create unique index if not exists chat_groups_direct_key_uidx
  on public.chat_groups (direct_key)
  where direct_key is not null;

create or replace function public.chat_open_direct(p_other uuid)
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
  if v_me is null then
    raise exception 'ログインが必要です';
  end if;
  if p_other is null or p_other = v_me then
    raise exception '自分以外のユーザーを選んでください';
  end if;
  if not exists (select 1 from public.chat_users where id = v_me) then
    raise exception '先に表示名を登録してください';
  end if;
  if not exists (select 1 from public.chat_users where id = p_other) then
    raise exception '相手のユーザーが見つかりません';
  end if;

  if v_me::text < p_other::text then
    v_key := v_me::text || ':' || p_other::text;
  else
    v_key := p_other::text || ':' || v_me::text;
  end if;

  select id into v_id
  from public.chat_groups
  where direct_key = v_key;

  if v_id is null then
    select string_agg(username, '・' order by username) into v_name
    from public.chat_users
    where id in (v_me, p_other);

    insert into public.chat_groups (group_name, created_by, is_direct, direct_key)
    values (coalesce(v_name, '友だち'), v_me, true, v_key)
    returning id into v_id;

    insert into public.chat_group_members (group_id, user_id)
    values (v_id, v_me)
    on conflict do nothing;

    insert into public.chat_group_members (group_id, user_id)
    values (v_id, p_other)
    on conflict do nothing;
  else
    insert into public.chat_group_members (group_id, user_id)
    values (v_id, v_me)
    on conflict do nothing;

    insert into public.chat_group_members (group_id, user_id)
    values (v_id, p_other)
    on conflict do nothing;
  end if;

  return v_id;
end;
$fn$;

revoke all on function public.chat_open_direct(uuid) from public, anon;
grant execute on function public.chat_open_direct(uuid) to authenticated;

create or replace function public.chat_prevent_direct_extra_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if exists (
    select 1 from public.chat_groups
    where id = new.group_id and is_direct
  ) and not exists (
    select 1 from public.chat_group_members
    where group_id = new.group_id and user_id = new.user_id
  ) and (
    select count(*) from public.chat_group_members
    where group_id = new.group_id
  ) >= 2 then
    raise exception '1対1トークには追加できません';
  end if;
  return new;
end;
$fn$;

drop trigger if exists chat_group_members_direct_limit on public.chat_group_members;
create trigger chat_group_members_direct_limit
before insert on public.chat_group_members
for each row execute function public.chat_prevent_direct_extra_member();
