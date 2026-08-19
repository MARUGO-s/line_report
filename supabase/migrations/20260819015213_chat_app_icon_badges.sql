-- chat PWAのホーム画面アイコンへ、ユーザー単位の未読合計を表示する。
-- chat-push Edge Functionがservice_roleから一括取得し、
-- Web Pushペイロードのbadge_countとして各購読端末へ渡す。

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
   and m.user_id <> recipients.user_id
   and (rs.last_read_at is null or m.created_at > rs.last_read_at)
  group by recipients.user_id
$fn$;

revoke all on function public.chat_push_unread_totals(uuid[]) from public, anon, authenticated;
grant execute on function public.chat_push_unread_totals(uuid[]) to service_role;

comment on function public.chat_push_unread_totals(uuid[]) is
  'Web Push通知用。指定ユーザーごとに参加中の全グループにある未読メッセージ合計をservice_roleだけへ返す。';
