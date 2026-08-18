-- Supabase Realtime を使ったグループチャット（public/chat.html から利用）。
--
-- 構成:
--   chat_users         … ユーザー（ユーザー名のみの簡易アカウント）
--   chat_groups        … トークルーム
--   chat_group_members … 参加関係（多対多）
--   chat_messages      … 発言。Realtime の INSERT イベントで各クライアントへ配信
--   chat_read_states   … 既読位置。未読バッジの算出に使う
--
-- ⚠️ アクセス制御についての割り切り:
-- 静的ページから公開 anon キーで直接読み書きするため、下記ポリシーは
-- 「URL と anon キーを知っていれば誰でも全チャットを読み書きできる」ことを意味する。
-- 社内連絡用途を想定した設計。機密情報を扱う場合は Supabase Auth を導入し、
-- ポリシーを auth.uid() 基準へ変更すること。

create table if not exists public.chat_users (
  id bigint primary key generated always as identity,
  username text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.chat_groups (
  id bigint primary key generated always as identity,
  group_name text not null,
  created_by bigint not null references public.chat_users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.chat_group_members (
  group_id bigint not null references public.chat_groups(id) on delete cascade,
  user_id bigint not null references public.chat_users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table if not exists public.chat_messages (
  id bigint primary key generated always as identity,
  group_id bigint not null references public.chat_groups(id) on delete cascade,
  user_id bigint not null references public.chat_users(id) on delete cascade,
  username text not null,
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.chat_read_states (
  group_id bigint not null references public.chat_groups(id) on delete cascade,
  user_id bigint not null references public.chat_users(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create index if not exists idx_chat_messages_group_created
  on public.chat_messages (group_id, created_at desc);

create index if not exists idx_chat_group_members_user
  on public.chat_group_members (user_id);

alter table public.chat_users enable row level security;
alter table public.chat_groups enable row level security;
alter table public.chat_group_members enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_read_states enable row level security;

-- anon（静的ページ）からの利用を許可する。上記の割り切りを参照。
drop policy if exists chat_users_anon_all on public.chat_users;
create policy chat_users_anon_all on public.chat_users
  for all to anon, authenticated using (true) with check (true);

drop policy if exists chat_groups_anon_all on public.chat_groups;
create policy chat_groups_anon_all on public.chat_groups
  for all to anon, authenticated using (true) with check (true);

drop policy if exists chat_group_members_anon_all on public.chat_group_members;
create policy chat_group_members_anon_all on public.chat_group_members
  for all to anon, authenticated using (true) with check (true);

-- 発言は編集・削除させない（追記のみ）。
drop policy if exists chat_messages_anon_read on public.chat_messages;
create policy chat_messages_anon_read on public.chat_messages
  for select to anon, authenticated using (true);

drop policy if exists chat_messages_anon_insert on public.chat_messages;
create policy chat_messages_anon_insert on public.chat_messages
  for insert to anon, authenticated with check (char_length(content) between 1 and 2000);

drop policy if exists chat_read_states_anon_all on public.chat_read_states;
create policy chat_read_states_anon_all on public.chat_read_states
  for all to anon, authenticated using (true) with check (true);

-- 未読件数: 自分の既読時刻より後に届いた「自分以外の」発言を数える。
create or replace function public.chat_unread_counts(p_user_id bigint)
returns table (group_id bigint, unread_count bigint)
language sql
stable
set search_path = public
as $$
  select m.group_id, count(*)::bigint
  from public.chat_messages m
  join public.chat_group_members gm
    on gm.group_id = m.group_id and gm.user_id = p_user_id
  left join public.chat_read_states rs
    on rs.group_id = m.group_id and rs.user_id = p_user_id
  where m.user_id <> p_user_id
    and (rs.last_read_at is null or m.created_at > rs.last_read_at)
  group by m.group_id
$$;

grant execute on function public.chat_unread_counts(bigint) to anon, authenticated;

comment on function public.chat_unread_counts(bigint) is
  'chat_read_states の既読時刻を基準に、参加中グループごとの未読件数を返す。';

-- Realtime 配信対象に追加（既に入っていれば何もしない）。
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'chat_messages'
  ) then
    alter publication supabase_realtime add table public.chat_messages;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'chat_groups'
  ) then
    alter publication supabase_realtime add table public.chat_groups;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'chat_group_members'
  ) then
    alter publication supabase_realtime add table public.chat_group_members;
  end if;
end
$$;
