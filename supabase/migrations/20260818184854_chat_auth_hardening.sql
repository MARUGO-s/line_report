-- チャットの認証強化。anon 全許可だった初版（20260818183443）を作り直す。
--
-- 塞ぐ穴:
--   ① ユーザー名だけでなりすませた      → Supabase Auth のログインを必須化
--   ② 未参加グループの会話まで読めた    → SELECT を参加者だけに制限
--   ③ 他人の発言・グループを消せた      → 発言とグループは追記のみ（UPDATE/DELETE 不可）
--   ④ 発言者名を偽装できた              → トリガで auth.uid() から強制的に上書き
--
-- 加えて、許可リスト chat_allowed_emails に載っているメールでないと
-- プロフィールを作れない＝チャットを一切利用できない。
-- 初版は本番稼働前でデータが無いため、作り直す。
--
-- ⚠️ 冒頭の drop table はチャット履歴を消す。適用済み（version 20260818184854）なので
-- db push は再実行しないが、手動で流し直さないこと。

drop table if exists public.chat_read_states;
drop table if exists public.chat_messages;
drop table if exists public.chat_group_members;
drop table if exists public.chat_groups;
drop table if exists public.chat_users;
drop function if exists public.chat_unread_counts(bigint);

-- 利用を許可するメール。service_role（管理者）だけが操作でき、
-- 一般ユーザーからは存在ごと見えない（ポリシーを作らない＝全拒否）。
create table if not exists public.chat_allowed_emails (
  email text primary key,
  note text,
  created_at timestamptz not null default now()
);

alter table public.chat_allowed_emails enable row level security;

create table public.chat_users (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  created_at timestamptz not null default now()
);

create table public.chat_groups (
  id bigint primary key generated always as identity,
  group_name text not null,
  created_by uuid not null references public.chat_users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.chat_group_members (
  group_id bigint not null references public.chat_groups(id) on delete cascade,
  user_id uuid not null references public.chat_users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table public.chat_messages (
  id bigint primary key generated always as identity,
  group_id bigint not null references public.chat_groups(id) on delete cascade,
  user_id uuid not null references public.chat_users(id) on delete cascade,
  username text not null,
  content text not null,
  created_at timestamptz not null default now()
);

create table public.chat_read_states (
  group_id bigint not null references public.chat_groups(id) on delete cascade,
  user_id uuid not null references public.chat_users(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create index if not exists idx_chat_messages_group_created
  on public.chat_messages (group_id, created_at desc);

create index if not exists idx_chat_group_members_user
  on public.chat_group_members (user_id);

-- ポリシーから参照する判定関数。security definer にしないと
-- chat_group_members 自身のポリシー評価が再帰する。
create or replace function public.chat_is_registered()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (select 1 from public.chat_users where id = auth.uid())
$fn$;

create or replace function public.chat_is_member(p_group_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1 from public.chat_group_members
    where group_id = p_group_id and user_id = auth.uid()
  )
$fn$;

revoke all on function public.chat_is_registered() from public, anon;
revoke all on function public.chat_is_member(bigint) from public, anon;
grant execute on function public.chat_is_registered() to authenticated;
grant execute on function public.chat_is_member(bigint) to authenticated;

-- プロフィール作成を許可リストに限定する。
create or replace function public.chat_enforce_allowed_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_email text;
begin
  -- service_role / SQL エディタからの投入（auth.uid() が無い）は素通し。
  if auth.uid() is null then
    return new;
  end if;

  if new.id <> auth.uid() then
    raise exception 'プロフィールは本人のみ作成できます';
  end if;

  select email into v_email from auth.users where id = new.id;

  if v_email is null or not exists (
    select 1 from public.chat_allowed_emails where lower(email) = lower(v_email)
  ) then
    raise exception 'このメールアドレスはチャットの利用を許可されていません';
  end if;

  return new;
end;
$fn$;

create trigger chat_users_allowed_email
before insert on public.chat_users
for each row execute function public.chat_enforce_allowed_email();

-- 発言者とグループ作成者はクライアントの申告を信用せず、必ずログイン情報から決める。
create or replace function public.chat_set_message_author()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is not null then
    new.user_id := auth.uid();
    select username into new.username from public.chat_users where id = auth.uid();
  end if;

  if new.username is null then
    raise exception 'チャットのプロフィールがありません';
  end if;

  new.created_at := now();
  return new;
end;
$fn$;

create trigger chat_messages_set_author
before insert on public.chat_messages
for each row execute function public.chat_set_message_author();

create or replace function public.chat_set_group_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  new.created_at := now();
  return new;
end;
$fn$;

create trigger chat_groups_set_owner
before insert on public.chat_groups
for each row execute function public.chat_set_group_owner();

alter table public.chat_users enable row level security;
alter table public.chat_groups enable row level security;
alter table public.chat_group_members enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_read_states enable row level security;

-- 以下すべて to authenticated。anon には一切ポリシーを与えない＝全拒否。

-- 自分のプロフィールだけ。他人の一覧は取得できない。
create policy chat_users_select_self on public.chat_users
  for select to authenticated using (id = auth.uid());

create policy chat_users_insert_self on public.chat_users
  for insert to authenticated with check (id = auth.uid());

-- 参加できるグループを探せるよう、登録済みユーザーには一覧を見せる（本文は見えない）。
create policy chat_groups_select on public.chat_groups
  for select to authenticated using (public.chat_is_registered());

create policy chat_groups_insert on public.chat_groups
  for insert to authenticated with check (public.chat_is_registered());

-- 参加関係は、自分の分と、自分が参加しているグループの分だけ。
create policy chat_group_members_select on public.chat_group_members
  for select to authenticated
  using (user_id = auth.uid() or public.chat_is_member(group_id));

create policy chat_group_members_insert_self on public.chat_group_members
  for insert to authenticated
  with check (user_id = auth.uid() and public.chat_is_registered());

create policy chat_group_members_delete_self on public.chat_group_members
  for delete to authenticated using (user_id = auth.uid());

-- 発言は参加者だけが読める。Realtime もこのポリシーに従うため、
-- 未参加グループの新着は配信自体されない。
create policy chat_messages_select_member on public.chat_messages
  for select to authenticated using (public.chat_is_member(group_id));

create policy chat_messages_insert_member on public.chat_messages
  for insert to authenticated
  with check (
    public.chat_is_member(group_id)
    and char_length(content) between 1 and 2000
  );

-- 既読位置は自分の分のみ。
create policy chat_read_states_own on public.chat_read_states
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 未読件数。引数を廃止し、必ず auth.uid() 自身の分だけを返す。
create or replace function public.chat_unread_counts()
returns table (group_id bigint, unread_count bigint)
language sql
stable
security definer
set search_path = public
as $fn$
  select m.group_id, count(*)::bigint
  from public.chat_messages m
  join public.chat_group_members gm
    on gm.group_id = m.group_id and gm.user_id = auth.uid()
  left join public.chat_read_states rs
    on rs.group_id = m.group_id and rs.user_id = auth.uid()
  where m.user_id <> auth.uid()
    and (rs.last_read_at is null or m.created_at > rs.last_read_at)
  group by m.group_id
$fn$;

revoke all on function public.chat_unread_counts() from public, anon;
grant execute on function public.chat_unread_counts() to authenticated;

comment on function public.chat_unread_counts() is
  'ログイン中ユーザーの未読件数をグループごとに返す。他人の分は取得できない。';

comment on table public.chat_allowed_emails is
  'チャット利用を許可するメール。ここに無いメールではプロフィールを作れない＝利用不可。';

-- Realtime 配信対象（テーブル再作成で外れているため入れ直す）。
do $blk$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_messages'
  ) then
    alter publication supabase_realtime add table public.chat_messages;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_groups'
  ) then
    alter publication supabase_realtime add table public.chat_groups;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_group_members'
  ) then
    alter publication supabase_realtime add table public.chat_group_members;
  end if;
end
$blk$;
