-- 店舗Botを登録ユーザーとして作る。LINEの公式アカウントと同じで、
-- そのBotがいるルームの投稿を紐づいた店舗へ送る。

alter table public.chat_users
  add column if not exists is_bot boolean not null default false,
  add column if not exists store_key text;

comment on column public.chat_users.is_bot is
  'M-talk のBot。ログインさせない。店舗Botは store_key を持つ。';
comment on column public.chat_users.store_key is
  '店舗Botの店舗キー。予約通知Botは null。';

create unique index if not exists chat_users_store_bot_uidx
  on public.chat_users (store_key)
  where is_bot and store_key is not null;

update public.chat_users
set is_bot = true
where id = '00000000-0000-4000-8000-00000000b071'
   or username = '予約通知';

create or replace function public.chat_store_bot_id(p_store_key text)
returns uuid
language sql
immutable
as $fn$
  select (
    substr(h, 1, 8) || '-' ||
    substr(h, 9, 4) || '-' ||
    '4' || substr(h, 14, 3) || '-' ||
    '8' || substr(h, 18, 3) || '-' ||
    substr(h, 21, 12)
  )::uuid
  from (select md5('mtalk-store-bot:' || lower(trim(p_store_key))) as h) s;
$fn$;

comment on function public.chat_store_bot_id(text) is
  '店舗キーから店舗Botの安定したUUIDを作る。';

create or replace function public.chat_users_protect_bot_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      new.is_bot := false;
      new.store_key := null;
    else
      new.is_bot := old.is_bot;
      new.store_key := old.store_key;
    end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists chat_users_protect_bot_fields on public.chat_users;
create trigger chat_users_protect_bot_fields
before insert or update on public.chat_users
for each row execute function public.chat_users_protect_bot_fields();

create or replace function public.chat_join_store_rooms()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.is_bot then
    if new.store_key is not null then
      insert into public.chat_group_members (group_id, user_id)
      select g.id, new.id
      from public.chat_groups g
      where g.is_store_room and g.store_key = new.store_key
      on conflict (group_id, user_id) do nothing;
    end if;
    return new;
  end if;

  insert into public.chat_group_members (group_id, user_id)
  select g.id, new.id
  from public.chat_groups g
  where g.is_store_room
  on conflict (group_id, user_id) do nothing;
  return new;
end;
$fn$;

do $$
declare
  r record;
  v_id uuid;
  v_name text;
  v_email text;
begin
  for r in
    select g.store_key, g.group_name
    from public.chat_groups g
    where g.is_store_room and nullif(trim(g.store_key), '') is not null
  loop
    v_id := public.chat_store_bot_id(r.store_key);
    v_email := 'store-bot-' || lower(r.store_key) || '@marugo.invalid';
    v_name := coalesce(nullif(trim(r.group_name), ''), r.store_key);
    if exists (select 1 from public.chat_users u where u.username = v_name and u.id <> v_id) then
      v_name := v_name || '（店舗Bot）';
    end if;
    if exists (select 1 from public.chat_users u where u.username = v_name and u.id <> v_id) then
      v_name := r.store_key || '-bot';
    end if;

    insert into auth.users (
      instance_id,
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      created_at,
      updated_at,
      raw_app_meta_data,
      raw_user_meta_data,
      is_sso_user,
      is_anonymous,
      banned_until
    ) values (
      '00000000-0000-0000-0000-000000000000',
      v_id,
      'authenticated',
      'authenticated',
      v_email,
      extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')),
      now(),
      now(),
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('bot', true, 'store_key', r.store_key),
      false,
      false,
      'infinity'
    )
    on conflict (id) do nothing;

    insert into public.chat_users (id, username, is_bot, store_key)
    values (v_id, v_name, true, r.store_key)
    on conflict (id) do update
      set is_bot = true,
          store_key = excluded.store_key;
  end loop;
end $$;

insert into public.chat_group_members (group_id, user_id)
select g.id, u.id
from public.chat_groups g
join public.chat_users u
  on u.is_bot and u.store_key = g.store_key
where g.is_store_room
on conflict (group_id, user_id) do nothing;

-- 店舗ルームのBotは店舗Botだけにする（予約通知は予約ルーム用）
delete from public.chat_group_members m
using public.chat_groups g
where m.group_id = g.id
  and g.is_store_room
  and m.user_id = '00000000-0000-4000-8000-00000000b071'::uuid;

create or replace function public.chat_enqueue_knowledge_dispatch()
returns trigger
language plpgsql
security definer
set search_path = public, net, pg_catalog
as $fn$
declare
  v_secret text;
begin
  if exists (
    select 1 from public.chat_users u
    where u.id = new.user_id and u.is_bot
  ) then
    return new;
  end if;

  if not exists (
    select 1
    from public.chat_groups g
    where g.id = new.group_id
      and (
        g.is_store_room
        or exists (
          select 1
          from public.chat_group_members m
          join public.chat_users u on u.id = m.user_id
          where m.group_id = g.id
            and u.is_bot
            and u.store_key is not null
        )
      )
  ) then
    return new;
  end if;

  select dispatch_secret into v_secret
  from public.chat_push_internal_config
  where id = true;

  if v_secret is null or v_secret = '' then
    return new;
  end if;

  perform net.http_post(
    url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/chat-knowledge?action=dispatch',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_secret,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('message_id', new.id),
    timeout_milliseconds := 60000
  );
  return new;
exception
  when others then
    return new;
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
  v_store_room boolean;
  v_is_bot boolean;
  v_store_key text;
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

  select created_by, coalesce(is_direct, false), coalesce(is_store_room, false)
    into v_owner, v_direct, v_store_room
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

  select coalesce(is_bot, false), store_key
    into v_is_bot, v_store_key
  from public.chat_users
  where id = p_user_id;

  if p_user_id = '00000000-0000-4000-8000-00000000b071'::uuid or (v_is_bot and v_store_key is null) then
    raise exception 'このアカウントは退出させられません';
  end if;
  if v_is_bot and v_store_room then
    raise exception '店舗Botは店舗ルームから退出させられません';
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

revoke all on function public.chat_store_bot_id(text) from public, anon, authenticated;
revoke all on function public.chat_users_protect_bot_fields() from public, anon, authenticated;
revoke all on function public.chat_enqueue_knowledge_dispatch() from public, anon, authenticated;
revoke all on function public.chat_kick_member(bigint, uuid) from public, anon;
grant execute on function public.chat_kick_member(bigint, uuid) to authenticated;
