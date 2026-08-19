-- chat.html に 既読表示 / リアクション / 返信・引用 / メンション を足す。

-- ① 既読表示 ----------------------------------------------------------------
--
-- chat_read_states は「自分の行だけ」だったので、他の人が読んだかどうかを
-- 知る手段が無かった。同じグループの参加者どうしは互いの既読時刻を
-- 見られるようにする（＝既読表示そのもの）。書き込みは従来どおり自分の分だけ。

drop policy if exists chat_read_states_own on public.chat_read_states;

create policy chat_read_states_select_member on public.chat_read_states
  for select to authenticated
  using (user_id = auth.uid() or public.chat_is_member(group_id));

create policy chat_read_states_insert_self on public.chat_read_states
  for insert to authenticated with check (user_id = auth.uid());

create policy chat_read_states_update_self on public.chat_read_states
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy chat_read_states_delete_self on public.chat_read_states
  for delete to authenticated using (user_id = auth.uid());

-- ② 返信・引用 --------------------------------------------------------------

alter table public.chat_messages
  add column if not exists reply_to_id bigint
    references public.chat_messages(id) on delete set null;

create index if not exists idx_chat_messages_reply_to
  on public.chat_messages (reply_to_id)
  where reply_to_id is not null;

-- ③ メンション --------------------------------------------------------------
--
-- 本文の @表示名 と対応するユーザーID。誰宛かはクライアントの申告ではなく
-- トリガで検証し、そのグループの参加者だけを残す。

alter table public.chat_messages
  add column if not exists mentions uuid[] not null default '{}'::uuid[];

create index if not exists idx_chat_messages_mentions
  on public.chat_messages using gin (mentions);

-- ④ リアクション ------------------------------------------------------------

create table if not exists public.chat_message_reactions (
  message_id bigint not null references public.chat_messages(id) on delete cascade,
  user_id uuid not null references public.chat_users(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create index if not exists idx_chat_message_reactions_message
  on public.chat_message_reactions (message_id);

alter table public.chat_message_reactions enable row level security;

-- その発言が属するグループの参加者かどうか。ポリシーから使うので security definer。
create or replace function public.chat_is_member_of_message(p_message_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from public.chat_messages m
    join public.chat_group_members gm
      on gm.group_id = m.group_id and gm.user_id = auth.uid()
    where m.id = p_message_id
  )
$fn$;

revoke all on function public.chat_is_member_of_message(bigint) from public, anon;
grant execute on function public.chat_is_member_of_message(bigint) to authenticated;

create policy chat_reactions_select_member on public.chat_message_reactions
  for select to authenticated
  using (public.chat_is_member_of_message(message_id));

-- 付けられるのは自分の分だけ。絵文字は短い文字列に限る。
create policy chat_reactions_insert_self on public.chat_message_reactions
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.chat_is_member_of_message(message_id)
    and char_length(emoji) between 1 and 16
  );

-- 発言と違い、リアクションは自分の分を取り消せる。
create policy chat_reactions_delete_self on public.chat_message_reactions
  for delete to authenticated using (user_id = auth.uid());

-- ⑤ 返信先とメンションの検証 -------------------------------------------------

create or replace function public.chat_set_message_author()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_path text;
  v_w text;
  v_h text;
begin
  if auth.uid() is not null then
    new.user_id := auth.uid();
    select username into new.username from public.chat_users where id = auth.uid();

    if new.kind is null or new.kind not in ('text', 'image') then
      new.kind := 'text';
    end if;

    if new.kind = 'text' then
      new.payload := null;
    else
      v_path := nullif(new.payload #>> '{image,path}', '');
      if v_path is null or v_path not like 'groups/' || new.group_id::text || '/%' then
        raise exception '画像メッセージの保存先が不正です';
      end if;

      v_w := nullif(regexp_replace(coalesce(new.payload #>> '{image,w}', ''), '\D', '', 'g'), '');
      v_h := nullif(regexp_replace(coalesce(new.payload #>> '{image,h}', ''), '\D', '', 'g'), '');

      new.payload := jsonb_strip_nulls(jsonb_build_object(
        'v', 1,
        'kind', 'image',
        'image', jsonb_strip_nulls(jsonb_build_object(
          'path', v_path,
          'w', case when v_w is null then null else to_jsonb(v_w::int) end,
          'h', case when v_h is null then null else to_jsonb(v_h::int) end
        ))
      ));
    end if;
  end if;

  if new.username is null then
    raise exception 'チャットのプロフィールがありません';
  end if;

  if new.kind in ('card', 'image') and new.payload is null then
    raise exception 'このメッセージ種別には payload が必要です';
  end if;

  -- 返信先は同じトークルームの発言に限る（他ルームの本文を引用させない）。
  if new.reply_to_id is not null then
    if not exists (
      select 1 from public.chat_messages
      where id = new.reply_to_id and group_id = new.group_id
    ) then
      raise exception '返信先の発言が同じトークルームにありません';
    end if;
  end if;

  -- メンションはクライアントの申告を信用せず、参加者だけに絞り込む。
  if new.mentions is null then
    new.mentions := '{}'::uuid[];
  elsif array_length(new.mentions, 1) is not null then
    select coalesce(array_agg(distinct gm.user_id), '{}'::uuid[])
      into new.mentions
    from public.chat_group_members gm
    where gm.group_id = new.group_id
      and gm.user_id = any(new.mentions);
  end if;

  new.created_at := now();
  return new;
end;
$fn$;

-- ⑥ Realtime ---------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'chat_message_reactions'
  ) then
    alter publication supabase_realtime add table public.chat_message_reactions;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'chat_read_states'
  ) then
    alter publication supabase_realtime add table public.chat_read_states;
  end if;
end
$$;

-- リアクションの取り消し(DELETE)を Realtime で拾うには、
-- 旧行に主キー以外も載せる必要がある。
alter table public.chat_message_reactions replica identity full;
