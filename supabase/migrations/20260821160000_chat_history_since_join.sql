-- 新規参加者には参加時刻以降の発言だけを見せる。
-- 本文だけでなく、検索・Realtime・リアクション・未読数も同じ境界へ揃える。

create or replace function public.chat_can_read_message(
  p_group_id bigint,
  p_created_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from public.chat_group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = auth.uid()
      and p_created_at >= gm.joined_at
  )
$fn$;

revoke all on function public.chat_can_read_message(bigint, timestamptz) from public, anon;
grant execute on function public.chat_can_read_message(bigint, timestamptz) to authenticated;

drop policy if exists chat_messages_select_member on public.chat_messages;
create policy chat_messages_select_since_join on public.chat_messages
  for select to authenticated
  using (public.chat_can_read_message(group_id, created_at));

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
      on gm.group_id = m.group_id
     and gm.user_id = auth.uid()
     and m.created_at >= gm.joined_at
    where m.id = p_message_id
  )
$fn$;

revoke all on function public.chat_is_member_of_message(bigint) from public, anon;
grant execute on function public.chat_is_member_of_message(bigint) to authenticated;

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
    on gm.group_id = m.group_id
   and gm.user_id = auth.uid()
   and m.created_at >= gm.joined_at
  left join public.chat_read_states rs
    on rs.group_id = m.group_id and rs.user_id = auth.uid()
  where m.user_id <> auth.uid()
    and (rs.last_read_at is null or m.created_at > rs.last_read_at)
  group by m.group_id
$fn$;

revoke all on function public.chat_unread_counts() from public, anon;
grant execute on function public.chat_unread_counts() to authenticated;

create or replace function public.chat_push_unread_totals(p_user_ids uuid[])
returns table (user_id uuid, unread_count bigint)
language sql
stable
security definer
set search_path = public
as $fn$
  with recipients as (
    select distinct value as user_id
    from unnest(coalesce(p_user_ids, array[]::uuid[])) as ids(value)
    where value is not null
  )
  select recipients.user_id,
         count(m.id)::bigint as unread_count
  from recipients
  left join public.chat_group_members gm
    on gm.user_id = recipients.user_id
  left join public.chat_read_states rs
    on rs.group_id = gm.group_id
   and rs.user_id = recipients.user_id
  left join public.chat_messages m
    on m.group_id = gm.group_id
   and m.created_at >= gm.joined_at
   and m.user_id <> recipients.user_id
   and (rs.last_read_at is null or m.created_at > rs.last_read_at)
  group by recipients.user_id
$fn$;

revoke all on function public.chat_push_unread_totals(uuid[]) from public, anon, authenticated;
grant execute on function public.chat_push_unread_totals(uuid[]) to service_role;

comment on function public.chat_can_read_message(bigint, timestamptz) is
  '参加者がjoined_at以降の発言だけを参照できるか判定する。RLSとRealtimeで共用。';
