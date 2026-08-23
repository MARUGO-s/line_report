-- 小表示の感情イラストは、入力された本文を同じ吹き出しへ保存できるようにする。
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
  v_sticker_id text;
  v_sticker_label text;
  v_sticker_path text;
  v_sticker_display text;
begin
  if auth.uid() is not null then
    new.user_id := auth.uid();
    select username into new.username from public.chat_users where id = auth.uid();

    if new.kind is null or new.kind not in ('text', 'image', 'sticker') then new.kind := 'text'; end if;
    if new.kind = 'text' then
      new.payload := null;
    elsif new.kind = 'image' then
      v_path := nullif(new.payload #>> '{image,path}', '');
      if v_path is null or v_path not like 'groups/' || new.group_id::text || '/%' then
        raise exception '画像メッセージの保存先が不正です';
      end if;
      v_w := nullif(regexp_replace(coalesce(new.payload #>> '{image,w}', ''), '\D', '', 'g'), '');
      v_h := nullif(regexp_replace(coalesce(new.payload #>> '{image,h}', ''), '\D', '', 'g'), '');
      new.payload := jsonb_strip_nulls(jsonb_build_object('v', 1, 'kind', 'image', 'image',
        jsonb_strip_nulls(jsonb_build_object('path', v_path,
          'w', case when v_w is null then null else to_jsonb(v_w::int) end,
          'h', case when v_h is null then null else to_jsonb(v_h::int) end))));
    else
      v_sticker_id := nullif(new.payload #>> '{sticker,id}', '');
      v_sticker_display := case when new.payload #>> '{sticker,display}' = 'compact' then 'compact' else 'large' end;
      select label, asset_path into v_sticker_label, v_sticker_path
      from public.chat_stickers where id = v_sticker_id and is_active;
      if v_sticker_path is null then raise exception '利用できない感情イラストです'; end if;
      if v_sticker_display = 'compact' and nullif(btrim(new.content), '') is not null
        and new.content <> '[感情イラスト]' then
        new.content := left(new.content, 2000);
      else
        new.content := '[感情イラスト] ' || v_sticker_label;
      end if;
      new.payload := jsonb_build_object('v', 1, 'kind', 'sticker', 'sticker',
        jsonb_build_object('id', v_sticker_id, 'label', v_sticker_label, 'path', v_sticker_path,
          'display', v_sticker_display));
    end if;
  end if;

  if new.username is null then raise exception 'チャットのプロフィールがありません'; end if;
  if new.kind in ('card', 'image', 'sticker') and new.payload is null then
    raise exception 'このメッセージ種別には payload が必要です';
  end if;
  if new.reply_to_id is not null and not exists (
    select 1 from public.chat_messages where id = new.reply_to_id and group_id = new.group_id
  ) then raise exception '返信先の発言が同じトークルームにありません'; end if;
  if new.mentions is null then
    new.mentions := '{}'::uuid[];
  elsif array_length(new.mentions, 1) is not null then
    select coalesce(array_agg(distinct gm.user_id), '{}'::uuid[]) into new.mentions
    from public.chat_group_members gm
    where gm.group_id = new.group_id and gm.user_id = any(new.mentions);
  end if;
  new.created_at := now();
  return new;
end;
$fn$;
