-- 感情イラスト（スタンプ）の予約配信を許可する
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
  v_raw_w text;
  v_raw_h text;
  v_w integer;
  v_h integer;
  v_id bigint;
begin
  if auth.uid() is null or not public.chat_can_send_group(p_group_id) then
    raise exception 'このルームへ予約送信する権限がありません';
  end if;

  v_kind := coalesce(nullif(btrim(p_kind), ''), 'text');
  if v_kind not in ('text', 'image', 'sticker') then
    raise exception '予約できるメッセージ種別ではありません';
  end if;
  if p_send_at is null then raise exception '送信日時を指定してください'; end if;
  if p_send_at < clock_timestamp() + interval '30 seconds' then
    raise exception '送信日時は現在より後にしてください';
  end if;
  if p_send_at > clock_timestamp() + interval '365 days' then
    raise exception '送信日時は1年以内にしてください';
  end if;
  if p_reply_to_id is not null and not exists (
    select 1 from public.chat_messages
    where id = p_reply_to_id and group_id = p_group_id
      and public.chat_can_read_message(group_id, created_at)
  ) then
    raise exception '返信先の発言が同じトークルームにありません';
  end if;

  if v_kind = 'image' then
    v_path := nullif(p_payload #>> '{image,path}', '');
    if v_path is null or v_path not like 'groups/' || p_group_id::text || '/%' then
      raise exception '画像の保存先が不正です';
    end if;
    v_raw_w := p_payload #>> '{image,w}';
    v_raw_h := p_payload #>> '{image,h}';
    if coalesce(v_raw_w, '') ~ '^[1-9][0-9]{0,4}$' then v_w := v_raw_w::integer; end if;
    if coalesce(v_raw_h, '') ~ '^[1-9][0-9]{0,4}$' then v_h := v_raw_h::integer; end if;
    p_payload := jsonb_strip_nulls(jsonb_build_object(
      'v', 1,
      'kind', 'image',
      'image', jsonb_strip_nulls(jsonb_build_object('path', v_path, 'w', v_w, 'h', v_h))
    ));
    v_content := coalesce(nullif(btrim(p_content), ''), '[画像]');
  elsif v_kind = 'sticker' then
    if p_payload is null or not p_payload ? 'sticker' then
      raise exception 'イラストの情報がありません';
    end if;
    p_payload := jsonb_strip_nulls(jsonb_build_object(
      'v', 1,
      'kind', 'sticker',
      'sticker', jsonb_strip_nulls(jsonb_build_object(
        'id', p_payload #>> '{sticker,id}',
        'display', p_payload #>> '{sticker,display}'
      ))
    ));
    v_content := coalesce(nullif(btrim(p_content), ''), '[感情イラスト]');
  else
    v_content := btrim(coalesce(p_content, ''));
    if v_content = '' then raise exception 'メッセージを入力してください'; end if;
    p_payload := null;
  end if;
  if char_length(v_content) > 2000 then raise exception 'メッセージが長すぎます'; end if;

  if array_length(p_mentions, 1) is not null then
    select coalesce(array_agg(distinct gm.user_id), '{}'::uuid[])
      into p_mentions
    from public.chat_group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = any(p_mentions);
  end if;

  insert into public.chat_scheduled_messages (
    group_id, user_id, content, kind, payload, reply_to_id, mentions, send_at
  ) values (
    p_group_id, auth.uid(), v_content, v_kind, p_payload,
    p_reply_to_id, coalesce(p_mentions, '{}'::uuid[]), p_send_at
  ) returning id into v_id;
  return v_id;
end;
$fn$;

revoke all on function public.chat_schedule_message(bigint, text, timestamptz, bigint, uuid[], text, jsonb) from public, anon;
grant execute on function public.chat_schedule_message(bigint, text, timestamptz, bigint, uuid[], text, jsonb) to authenticated;
