-- 予約送信を画像にも広げる。古い引数の関数は PostgREST が曖昧になるので消す。

drop function if exists public.chat_schedule_message(bigint, text, timestamptz, bigint, uuid[]);

create or replace function public.chat_schedule_message(
  p_group_id bigint,
  p_content text,
  p_send_at timestamptz,
  p_reply_to_id bigint default null,
  p_mentions uuid[] default '{}',
  p_kind text default 'text',
  p_payload jsonb default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_content text;
  v_kind text;
  v_path text;
  v_id bigint;
begin
  if auth.uid() is null then
    raise exception 'ログインしてください';
  end if;
  if not public.chat_is_member(p_group_id) then
    raise exception 'このルームに参加していません';
  end if;

  v_kind := coalesce(nullif(btrim(p_kind), ''), 'text');
  if v_kind not in ('text', 'image') then
    raise exception '予約できるメッセージ種別ではありません';
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

  if v_kind = 'image' then
    v_path := nullif(p_payload #>> '{image,path}', '');
    if v_path is null or v_path not like 'groups/' || p_group_id::text || '/%' then
      raise exception '画像の保存先が不正です';
    end if;
    v_content := coalesce(nullif(btrim(p_content), ''), '[画像]');
  else
    v_content := btrim(coalesce(p_content, ''));
    if v_content = '' then
      raise exception 'メッセージを入力してください';
    end if;
    p_payload := null;
  end if;
  if char_length(v_content) > 2000 then
    raise exception 'メッセージが長すぎます';
  end if;

  insert into public.chat_scheduled_messages (
    group_id, user_id, content, kind, payload, reply_to_id, mentions, send_at
  ) values (
    p_group_id,
    auth.uid(),
    v_content,
    v_kind,
    p_payload,
    p_reply_to_id,
    coalesce(p_mentions, '{}'::uuid[]),
    p_send_at
  )
  returning id into v_id;

  return v_id;
end;
$fn$;

revoke all on function public.chat_schedule_message(bigint, text, timestamptz, bigint, uuid[], text, jsonb) from public, anon;
grant execute on function public.chat_schedule_message(bigint, text, timestamptz, bigint, uuid[], text, jsonb) to authenticated;
