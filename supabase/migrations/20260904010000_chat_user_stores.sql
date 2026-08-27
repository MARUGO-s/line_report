-- M-talk の所属店舗。新規登録時は必須。複数可。変更は管理者の許可後に反映する。
-- 新しい1対1は、所属店舗が重なる相手（店舗Botはその店舗）だけ。

create table if not exists public.chat_store_catalog (
  store_key text primary key,
  display_name text not null,
  sort_order integer not null default 0,
  constraint chat_store_catalog_key_check check (
    store_key ~ '^[a-zA-Z][a-zA-Z0-9_]{1,40}$'
  ),
  constraint chat_store_catalog_name_check check (
    char_length(btrim(display_name)) between 1 and 80
  )
);

comment on table public.chat_store_catalog is
  'M-talkの所属店舗候補。pages-config の STORE_NAMES と揃える。';

insert into public.chat_store_catalog (store_key, display_name, sort_order) values
  ('barpelota', 'バルぺロタ', 10),
  ('bistrocavacava', 'ビストロ サヴァサヴァ', 20),
  ('briccola', 'トラットリア ブリッコラ', 30),
  ('claudia2', 'クラウディア2', 40),
  ('donaiya', '元祖どないや 新宿三丁目店', 50),
  ('erics', 'エリックスバイエリックトロション', 60),
  ('marugo', 'マルゴ', 70),
  ('marugoD', 'マルゴ D', 80),
  ('marugoS', 'マルゴエス', 90),
  ('marugogrande', 'マルゴ グランデ', 100),
  ('marugomarunouchi', 'マルゴ丸の内', 110),
  ('marugootto', 'マルゴ オット', 120),
  ('marugosecond', 'マルゴ セカンド', 130),
  ('marugoshinbashi', 'マルゴ 新橋', 140),
  ('marugoyotsuya', 'マルゴ 四谷', 150),
  ('mitan', 'ミタン', 160),
  ('sannanaichi', 'サンナナイチ バル', 170),
  ('sauvage', 'ソバージュ', 180),
  ('shenlong', 'シェンロン&クラウディア', 190),
  ('sushikoruri', '鮨こるり', 200),
  ('violette', 'ヴィオレット', 210),
  ('yakinikumarugo', '焼肉マルゴ', 220)
on conflict (store_key) do update
set display_name = excluded.display_name,
    sort_order = excluded.sort_order;

create table if not exists public.chat_user_stores (
  user_id uuid not null references public.chat_users(id) on delete cascade,
  store_key text not null references public.chat_store_catalog(store_key),
  created_at timestamptz not null default now(),
  primary key (user_id, store_key)
);

comment on table public.chat_user_stores is
  '許可済みの所属店舗。管理者承認後にだけ書き込む。';

create index if not exists chat_user_stores_store_key_idx
  on public.chat_user_stores (store_key);

create table if not exists public.chat_store_change_requests (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.chat_users(id) on delete cascade,
  kind text not null,
  requested_store_keys text[] not null,
  current_store_keys text[] not null default '{}'::text[],
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid,
  constraint chat_store_change_requests_kind_check
    check (kind in ('signup', 'change')),
  constraint chat_store_change_requests_status_check
    check (status in ('pending', 'approved', 'denied')),
  constraint chat_store_change_requests_keys_len_check
    check (
      cardinality(requested_store_keys) between 1 and 30
      and cardinality(current_store_keys) <= 30
    )
);

comment on table public.chat_store_change_requests is
  '所属店舗の申請。signupは新規登録時、changeは後からの変更。許可されるまで chat_user_stores は変わらない。';

create unique index if not exists chat_store_change_requests_one_pending
  on public.chat_store_change_requests (user_id)
  where status = 'pending';

create index if not exists chat_store_change_requests_user_idx
  on public.chat_store_change_requests (user_id, created_at desc);

alter table public.chat_store_catalog enable row level security;
alter table public.chat_user_stores enable row level security;
alter table public.chat_store_change_requests enable row level security;

revoke all on table public.chat_store_catalog from public, anon, authenticated;
revoke all on table public.chat_user_stores from public, anon, authenticated;
revoke all on table public.chat_store_change_requests from public, anon, authenticated;
grant select on table public.chat_store_catalog to authenticated;
grant select on table public.chat_user_stores to authenticated;
grant select on table public.chat_store_change_requests to authenticated;
grant select, insert, update, delete on table public.chat_store_catalog to service_role;
grant select, insert, update, delete on table public.chat_user_stores to service_role;
grant select, insert, update, delete on table public.chat_store_change_requests to service_role;

drop policy if exists chat_store_catalog_select on public.chat_store_catalog;
create policy chat_store_catalog_select on public.chat_store_catalog
  for select to authenticated using (true);

drop policy if exists chat_user_stores_select on public.chat_user_stores;
create policy chat_user_stores_select on public.chat_user_stores
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.chat_can_see_directory_user(user_id)
  );

drop policy if exists chat_store_change_requests_select_self on public.chat_store_change_requests;
create policy chat_store_change_requests_select_self on public.chat_store_change_requests
  for select to authenticated
  using (user_id = (select auth.uid()));

do $publication$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'chat_user_stores'
  ) then
    alter publication supabase_realtime add table public.chat_user_stores;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'chat_store_change_requests'
  ) then
    alter publication supabase_realtime add table public.chat_store_change_requests;
  end if;
end
$publication$;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------

create or replace function public.chat_normalize_store_keys(p_store_keys text[])
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_keys text[];
begin
  select coalesce(array_agg(c.store_key order by c.sort_order, c.store_key), '{}'::text[])
    into v_keys
  from (
    select distinct btrim(k) as store_key
    from unnest(coalesce(p_store_keys, '{}'::text[])) k
    where nullif(btrim(k), '') is not null
  ) src
  join public.chat_store_catalog c on c.store_key = src.store_key;

  if cardinality(v_keys) < 1 then
    raise exception '所属店舗を1つ以上選んでください';
  end if;
  return v_keys;
end;
$fn$;

create or replace function public.chat_store_display_names(p_store_keys text[])
returns text
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(string_agg(c.display_name, '、' order by c.sort_order, c.store_key), '')
  from unnest(coalesce(p_store_keys, '{}'::text[])) k(store_key)
  join public.chat_store_catalog c on c.store_key = k.store_key
$fn$;

create or replace function public.chat_user_store_keys(p_user_id uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(array_agg(s.store_key order by s.store_key), '{}'::text[])
  from public.chat_user_stores s
  where s.user_id = p_user_id
$fn$;

create or replace function public.chat_apply_user_stores(
  p_user_id uuid,
  p_store_keys text[]
)
returns text[]
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_keys text[] := public.chat_normalize_store_keys(p_store_keys);
begin
  delete from public.chat_user_stores where user_id = p_user_id;
  insert into public.chat_user_stores (user_id, store_key)
  select p_user_id, k
  from unnest(v_keys) k;
  return v_keys;
end;
$fn$;

create or replace function public.chat_shares_affiliation(p_a uuid, p_b uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_bot boolean;
  v_store text;
begin
  if p_a is null or p_b is null or p_a = p_b then
    return false;
  end if;

  select coalesce(is_bot, false), nullif(btrim(store_key), '')
    into v_bot, v_store
  from public.chat_users
  where id = p_b;
  if not found then return false; end if;

  if v_bot then
    if v_store is null then return false; end if;
    return exists (
      select 1 from public.chat_user_stores s
      where s.user_id = p_a and s.store_key = v_store
    );
  end if;

  select coalesce(is_bot, false), nullif(btrim(store_key), '')
    into v_bot, v_store
  from public.chat_users
  where id = p_a;
  if not found then return false; end if;
  if v_bot then
    if v_store is null then return false; end if;
    return exists (
      select 1 from public.chat_user_stores s
      where s.user_id = p_b and s.store_key = v_store
    );
  end if;

  return exists (
    select 1
    from public.chat_user_stores a
    join public.chat_user_stores b on b.store_key = a.store_key
    where a.user_id = p_a and b.user_id = p_b
  );
end;
$fn$;

revoke all on function public.chat_normalize_store_keys(text[]) from public, anon;
revoke all on function public.chat_store_display_names(text[]) from public, anon;
revoke all on function public.chat_user_store_keys(uuid) from public, anon;
revoke all on function public.chat_apply_user_stores(uuid, text[]) from public, anon, authenticated;
revoke all on function public.chat_shares_affiliation(uuid, uuid) from public, anon;
grant execute on function public.chat_normalize_store_keys(text[]) to authenticated, service_role;
grant execute on function public.chat_store_display_names(text[]) to authenticated, service_role;
grant execute on function public.chat_user_store_keys(uuid) to authenticated, service_role;
grant execute on function public.chat_apply_user_stores(uuid, text[]) to service_role;
grant execute on function public.chat_shares_affiliation(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 通知アクションを所属店舗の変更にも使う
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
  if v_action not in (
    'signup-notify',
    'signup-reviewed',
    'store-change-notify',
    'store-change-reviewed'
  ) then
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

-- 登録カードは所属店舗を付けてから送る。トリガでは送らない。
create or replace function public.chat_create_default_user_access()
returns trigger
language plpgsql
security definer
set search_path = public
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
  return new;
end;
$fn$;

revoke all on function public.chat_create_default_user_access() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 新規登録：表示名 + 所属店舗をまとめて申請
-- ---------------------------------------------------------------------------

create or replace function public.chat_complete_signup(
  p_username text,
  p_store_keys text[],
  p_icon_url text default null
)
returns public.chat_users
language plpgsql
security definer
set search_path = public, net, pg_catalog
as $fn$
declare
  v_me uuid := auth.uid();
  v_name text := btrim(coalesce(p_username, ''));
  v_keys text[];
  v_user public.chat_users;
  v_icon text := nullif(btrim(coalesce(p_icon_url, '')), '');
begin
  if v_me is null then
    raise exception 'ログインしてください';
  end if;
  if exists (select 1 from public.chat_users where id = v_me) then
    raise exception 'すでにプロフィールがあります';
  end if;
  if v_name = '' or char_length(v_name) > 50 then
    raise exception '表示名は1〜50文字で入力してください';
  end if;
  v_keys := public.chat_normalize_store_keys(p_store_keys);

  insert into public.chat_users (id, username, icon_url)
  values (v_me, v_name, v_icon)
  returning * into v_user;

  insert into public.chat_store_change_requests (
    user_id, kind, requested_store_keys, current_store_keys, status
  ) values (
    v_me, 'signup', v_keys, '{}'::text[], 'pending'
  );

  perform public.chat_enqueue_signup_dispatch(
    'signup-notify',
    jsonb_build_object(
      'user_id', v_me,
      'username', v_user.username,
      'store_keys', to_jsonb(v_keys),
      'store_names', public.chat_store_display_names(v_keys)
    )
  );
  return v_user;
end;
$fn$;

revoke all on function public.chat_complete_signup(text, text[], text) from public, anon;
grant execute on function public.chat_complete_signup(text, text[], text) to authenticated, service_role;

create or replace function public.chat_request_store_change(p_store_keys text[])
returns public.chat_store_change_requests
language plpgsql
security definer
set search_path = public, net, pg_catalog
as $fn$
declare
  v_me uuid := auth.uid();
  v_keys text[];
  v_current text[];
  v_row public.chat_store_change_requests;
  v_name text;
begin
  if v_me is null or not public.chat_is_registered() then
    raise exception 'ログインしてください';
  end if;
  if exists (
    select 1 from public.chat_store_change_requests
    where user_id = v_me and status = 'pending'
  ) then
    raise exception 'すでに所属店舗の変更を申請中です。管理者の許可を待ってください';
  end if;

  v_keys := public.chat_normalize_store_keys(p_store_keys);
  v_current := public.chat_user_store_keys(v_me);
  if v_keys = v_current then
    raise exception '所属店舗が変わっていません';
  end if;

  insert into public.chat_store_change_requests (
    user_id, kind, requested_store_keys, current_store_keys, status
  ) values (
    v_me, 'change', v_keys, v_current, 'pending'
  )
  returning * into v_row;

  select username into v_name from public.chat_users where id = v_me;
  perform public.chat_enqueue_signup_dispatch(
    'store-change-notify',
    jsonb_build_object(
      'request_id', v_row.id,
      'user_id', v_me,
      'username', v_name,
      'store_keys', to_jsonb(v_keys),
      'store_names', public.chat_store_display_names(v_keys),
      'current_store_names', public.chat_store_display_names(v_current)
    )
  );
  return v_row;
end;
$fn$;

revoke all on function public.chat_request_store_change(text[]) from public, anon;
grant execute on function public.chat_request_store_change(text[]) to authenticated, service_role;

create or replace function public.chat_review_store_change(
  p_request_id bigint,
  p_approve boolean
)
returns public.chat_store_change_requests
language plpgsql
security definer
set search_path = public, net, pg_catalog
as $fn$
declare
  v_me uuid := auth.uid();
  v_row public.chat_store_change_requests;
  v_name text;
  v_reviewer_name text;
  v_applied text[];
begin
  if v_me is null or not public.chat_is_signup_manager(v_me) then
    raise exception 'この操作はルームの管理権限が必要です';
  end if;

  select * into v_row
  from public.chat_store_change_requests
  where id = p_request_id
  for update;
  if not found then raise exception '申請が見つかりません'; end if;
  if v_row.status is distinct from 'pending' then
    raise exception 'この申請はすでに処理されています';
  end if;
  if v_row.user_id = v_me then
    raise exception '自分の申請は承認できません';
  end if;
  if v_row.kind is distinct from 'change' then
    raise exception 'この申請は所属店舗の変更ではありません';
  end if;

  if coalesce(p_approve, false) then
    v_applied := public.chat_apply_user_stores(v_row.user_id, v_row.requested_store_keys);
    update public.chat_store_change_requests
    set status = 'approved',
        reviewed_at = clock_timestamp(),
        reviewed_by = v_me,
        requested_store_keys = v_applied
    where id = v_row.id
    returning * into v_row;
  else
    update public.chat_store_change_requests
    set status = 'denied',
        reviewed_at = clock_timestamp(),
        reviewed_by = v_me
    where id = v_row.id
    returning * into v_row;
  end if;

  select username into v_name from public.chat_users where id = v_row.user_id;
  select username into v_reviewer_name from public.chat_users where id = v_me;
  perform public.chat_enqueue_signup_dispatch(
    'store-change-reviewed',
    jsonb_build_object(
      'request_id', v_row.id,
      'user_id', v_row.user_id,
      'username', v_name,
      'approved', coalesce(p_approve, false),
      'reviewer_name', v_reviewer_name,
      'store_names', public.chat_store_display_names(v_row.requested_store_keys)
    )
  );
  return v_row;
end;
$fn$;

revoke all on function public.chat_review_store_change(bigint, boolean) from public, anon;
grant execute on function public.chat_review_store_change(bigint, boolean) to authenticated, service_role;

-- 新規登録の許可時に、申請した所属店舗を反映する。
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
  v_req public.chat_store_change_requests;
  v_store_names text := '';
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

  select * into v_req
  from public.chat_store_change_requests
  where user_id = p_user_id
    and kind = 'signup'
    and status = 'pending'
  order by id desc
  limit 1
  for update;

  if coalesce(p_approve, false) then
    if v_req.id is not null then
      perform public.chat_apply_user_stores(p_user_id, v_req.requested_store_keys);
      update public.chat_store_change_requests
      set status = 'approved',
          reviewed_at = clock_timestamp(),
          reviewed_by = v_me
      where id = v_req.id;
      v_store_names := public.chat_store_display_names(v_req.requested_store_keys);
    end if;

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
    if v_req.id is not null then
      update public.chat_store_change_requests
      set status = 'denied',
          reviewed_at = clock_timestamp(),
          reviewed_by = v_me
      where id = v_req.id;
      v_store_names := public.chat_store_display_names(v_req.requested_store_keys);
    end if;

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
      'reviewer_name', v_reviewer_name,
      'store_names', v_store_names
    )
  );

  return v_after;
end;
$fn$;

revoke all on function public.chat_review_signup(uuid, boolean) from public, anon;
grant execute on function public.chat_review_signup(uuid, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 新しい1対1は所属店舗が重なる相手だけ
-- ---------------------------------------------------------------------------

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

  if v_me::text < p_other::text then
    v_key := v_me::text || ':' || p_other::text;
  else
    v_key := p_other::text || ':' || v_me::text;
  end if;

  select id into v_id
  from public.chat_groups
  where direct_key = v_key and is_direct;

  if v_id is null then
    if not public.chat_shares_affiliation(v_me, p_other) then
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
