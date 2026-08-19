-- M-talk の予約送信。入力時点では chat_messages に入れず、時刻到来で本人として投稿する。

create table if not exists public.chat_scheduled_messages (
  id bigint primary key generated always as identity,
  group_id bigint not null references public.chat_groups(id) on delete cascade,
  user_id uuid not null references public.chat_users(id) on delete cascade,
  content text not null,
  kind text not null default 'text' check (kind in ('text', 'image')),
  payload jsonb,
  reply_to_id bigint references public.chat_messages(id) on delete set null,
  mentions uuid[] not null default '{}',
  send_at timestamptz not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  cancelled_at timestamptz,
  sent_message_id bigint references public.chat_messages(id) on delete set null,
  error text
);

comment on table public.chat_scheduled_messages is
  'M-talk の予約送信。本人だけが作成・取消でき、時刻到来後に chat_messages へ投稿する。';

create index if not exists chat_scheduled_messages_due_idx
  on public.chat_scheduled_messages (send_at, id)
  where sent_at is null and cancelled_at is null;

create index if not exists chat_scheduled_messages_user_group_idx
  on public.chat_scheduled_messages (user_id, group_id, send_at);

alter table public.chat_scheduled_messages enable row level security;

create policy chat_scheduled_messages_select_own
  on public.chat_scheduled_messages
  for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on table public.chat_scheduled_messages from public, anon;
grant select on table public.chat_scheduled_messages to authenticated;

create or replace function public.chat_schedule_message(
  p_group_id bigint,
  p_content text,
  p_send_at timestamptz,
  p_reply_to_id bigint default null,
  p_mentions uuid[] default '{}'
)
returns bigint
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_content text;
  v_id bigint;
begin
  if auth.uid() is null then
    raise exception 'ログインしてください';
  end if;
  if not public.chat_is_member(p_group_id) then
    raise exception 'このルームに参加していません';
  end if;

  v_content := btrim(coalesce(p_content, ''));
  if v_content = '' then
    raise exception 'メッセージを入力してください';
  end if;
  if char_length(v_content) > 2000 then
    raise exception 'メッセージが長すぎます';
  end if;
  if p_send_at is null then
    raise exception '送信日時を指定してください';
  end if;
  if p_send_at < clock_timestamp() + interval '30 seconds' then
    raise exception '送信日時は現在より後にしてください';
  end if;
  if p_send_at > clock_timestamp() + interval '365 days' then
    raise exception '送信日時は1年以内にしてください';
  end if;
  if p_reply_to_id is not null and not exists (
    select 1 from public.chat_messages
    where id = p_reply_to_id and group_id = p_group_id
  ) then
    raise exception '返信先の発言が同じトークルームにありません';
  end if;

  insert into public.chat_scheduled_messages (
    group_id, user_id, content, kind, reply_to_id, mentions, send_at
  ) values (
    p_group_id,
    auth.uid(),
    v_content,
    'text',
    p_reply_to_id,
    coalesce(p_mentions, '{}'::uuid[]),
    p_send_at
  )
  returning id into v_id;

  return v_id;
end;
$fn$;

create or replace function public.chat_cancel_scheduled_message(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null then
    raise exception 'ログインしてください';
  end if;
  update public.chat_scheduled_messages
  set cancelled_at = clock_timestamp()
  where id = p_id
    and user_id = auth.uid()
    and sent_at is null
    and cancelled_at is null;
  if not found then
    raise exception '取り消せる予約送信がありません';
  end if;
end;
$fn$;

create or replace function public.chat_dispatch_scheduled_messages()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r record;
  v_username text;
  v_msg_id bigint;
  v_count integer := 0;
begin
  for r in
    select s.*
    from public.chat_scheduled_messages s
    where s.sent_at is null
      and s.cancelled_at is null
      and s.send_at <= clock_timestamp()
    order by s.send_at, s.id
    for update of s skip locked
    limit 50
  loop
    begin
      if not exists (
        select 1 from public.chat_group_members
        where group_id = r.group_id and user_id = r.user_id
      ) then
        update public.chat_scheduled_messages
        set cancelled_at = clock_timestamp(), error = 'このルームに参加していません'
        where id = r.id;
        continue;
      end if;

      select username into v_username
      from public.chat_users
      where id = r.user_id;
      if v_username is null then
        update public.chat_scheduled_messages
        set cancelled_at = clock_timestamp(), error = 'チャットのプロフィールがありません'
        where id = r.id;
        continue;
      end if;

      insert into public.chat_messages (
        group_id, user_id, username, content, kind, payload, reply_to_id, mentions
      ) values (
        r.group_id,
        r.user_id,
        v_username,
        r.content,
        case when r.kind in ('text', 'image') then r.kind else 'text' end,
        r.payload,
        r.reply_to_id,
        coalesce(r.mentions, '{}'::uuid[])
      )
      returning id into v_msg_id;

      update public.chat_scheduled_messages
      set sent_at = clock_timestamp(), sent_message_id = v_msg_id, error = null
      where id = r.id;
      v_count := v_count + 1;
    exception
      when others then
        update public.chat_scheduled_messages
        set error = left(sqlerrm, 300)
        where id = r.id;
    end;
  end loop;
  return v_count;
end;
$fn$;

revoke all on function public.chat_schedule_message(bigint, text, timestamptz, bigint, uuid[]) from public, anon;
revoke all on function public.chat_cancel_scheduled_message(bigint) from public, anon;
revoke all on function public.chat_dispatch_scheduled_messages() from public, anon, authenticated;
grant execute on function public.chat_schedule_message(bigint, text, timestamptz, bigint, uuid[]) to authenticated;
grant execute on function public.chat_cancel_scheduled_message(bigint) to authenticated;

do $$
begin
  begin
    perform cron.unschedule('chat-scheduled-messages-job');
  exception
    when others then
      null;
  end;
end
$$;

select cron.schedule(
  'chat-scheduled-messages-job',
  '* * * * *',
  $$ select public.chat_dispatch_scheduled_messages(); $$
);
