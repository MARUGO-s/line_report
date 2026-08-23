-- 予約配信テーブルの kind 制約に sticker を追加し、ディスパッチ処理で感情イラストを正しく配信できるようにする

alter table public.chat_scheduled_messages drop constraint if exists chat_scheduled_messages_kind_check;
alter table public.chat_scheduled_messages
  add constraint chat_scheduled_messages_kind_check check (kind in ('text', 'image', 'sticker'));

create or replace function public.chat_dispatch_scheduled_messages()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r record;
  v_username text;
  v_payload jsonb;
  v_path text;
  v_raw_w text;
  v_raw_h text;
  v_w integer;
  v_h integer;
  v_sticker_id text;
  v_sticker_label text;
  v_sticker_path text;
  v_sticker_display text;
  v_msg_content text;
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
      if not public.chat_has_active_access(r.user_id) or not exists (
        select 1
        from public.chat_group_members gm
        where gm.group_id = r.group_id
          and gm.user_id = r.user_id
          and gm.can_view = true
          and gm.can_send = true
      ) then
        update public.chat_scheduled_messages
        set cancelled_at = clock_timestamp(), error = '送信時点でルームの送信権限がありません'
        where id = r.id;
        continue;
      end if;

      select username into v_username from public.chat_users where id = r.user_id;
      if v_username is null then
        update public.chat_scheduled_messages
        set cancelled_at = clock_timestamp(), error = 'チャットのプロフィールがありません'
        where id = r.id;
        continue;
      end if;

      v_payload := null;
      v_path := null;
      v_raw_w := null;
      v_raw_h := null;
      v_w := null;
      v_h := null;
      v_sticker_id := null;
      v_sticker_label := null;
      v_sticker_path := null;
      v_sticker_display := null;
      v_msg_content := r.content;

      if r.kind = 'image' then
        v_path := nullif(r.payload #>> '{image,path}', '');
        if v_path is null or v_path not like 'groups/' || r.group_id::text || '/%' then
          raise exception '画像の保存先が不正です';
        end if;
        v_raw_w := r.payload #>> '{image,w}';
        v_raw_h := r.payload #>> '{image,h}';
        if coalesce(v_raw_w, '') ~ '^[1-9][0-9]{0,4}$' then v_w := v_raw_w::integer; end if;
        if coalesce(v_raw_h, '') ~ '^[1-9][0-9]{0,4}$' then v_h := v_raw_h::integer; end if;
        v_payload := jsonb_strip_nulls(jsonb_build_object(
          'v', 1,
          'kind', 'image',
          'image', jsonb_strip_nulls(jsonb_build_object('path', v_path, 'w', v_w, 'h', v_h))
        ));
      elsif r.kind = 'sticker' then
        v_sticker_id := nullif(r.payload #>> '{sticker,id}', '');
        v_sticker_display := case when r.payload #>> '{sticker,display}' = 'compact' then 'compact' else 'large' end;
        select label, asset_path into v_sticker_label, v_sticker_path
        from public.chat_stickers where id = v_sticker_id and is_active;
        if v_sticker_path is null then raise exception '利用できない感情イラストです'; end if;
        if v_sticker_display = 'compact' and nullif(btrim(r.content), '') is not null
          and r.content <> '[感情イラスト]' then
          v_msg_content := left(r.content, 2000);
        else
          v_msg_content := '[感情イラスト] ' || v_sticker_label;
        end if;
        v_payload := jsonb_build_object('v', 1, 'kind', 'sticker', 'sticker',
          jsonb_build_object('id', v_sticker_id, 'label', v_sticker_label, 'path', v_sticker_path,
            'display', v_sticker_display));
      end if;

      insert into public.chat_messages (
        group_id, user_id, username, content, kind, payload, reply_to_id, mentions
      ) values (
        r.group_id, r.user_id, v_username, v_msg_content,
        case when r.kind in ('text', 'image', 'sticker') then r.kind else 'text' end,
        v_payload, r.reply_to_id, coalesce(r.mentions, '{}'::uuid[])
      ) returning id into v_msg_id;

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

revoke all on function public.chat_dispatch_scheduled_messages() from public, anon, authenticated;
grant execute on function public.chat_dispatch_scheduled_messages() to service_role;
