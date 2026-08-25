-- スタンプの「文章内に入れる」を復旧する。
--
-- 20260828010000（ファイル添付）で chat_set_message_author を書き直した際、
-- スタンプ分岐から次の2つが落ちた。20260828011000 はメンション絞り込みだけを
-- 戻したため、スタンプ側は壊れたままだった。
--
--   ① payload の 'display'（compact/large）
--      → クライアントは sticker.display === 'compact' で表示を切り替えるため、
--        欠けると「文章内に入れる」が必ず large 表示になる。
--   ② compact のとき new.content を上書きしない
--      → 上書きすると、一緒に入力した文章が挿入時に消えて復元できない。
--
-- 他の分岐（画像・ファイル・返信先検証・メンション絞り込み）は
-- 20260828011000 のままで、ここでは変更しない。

create or replace function public.chat_set_message_author()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_path text; v_w text; v_h text;
  v_sticker_id text; v_sticker_label text; v_sticker_path text; v_sticker_display text;
  v_file_name text; v_file_mime text; v_file_size bigint;
begin
  if auth.uid() is not null then
    new.user_id := auth.uid();
    select username into new.username from public.chat_users where id = auth.uid();
    if new.kind is null or new.kind not in ('text','image','sticker','file') then new.kind := 'text'; end if;
    if new.kind = 'text' then
      new.payload := null;
    elsif new.kind = 'image' then
      v_path := nullif(new.payload #>> '{image,path}', '');
      if v_path is null or v_path not like 'groups/' || new.group_id::text || '/%' then raise exception '画像メッセージの保存先が不正です'; end if;
      v_w := nullif(regexp_replace(coalesce(new.payload #>> '{image,w}', ''), '\D', '', 'g'), '');
      v_h := nullif(regexp_replace(coalesce(new.payload #>> '{image,h}', ''), '\D', '', 'g'), '');
      new.payload := jsonb_strip_nulls(jsonb_build_object('v',1,'kind','image','image',jsonb_strip_nulls(jsonb_build_object('path',v_path,'w',case when v_w is null then null else to_jsonb(v_w::int) end,'h',case when v_h is null then null else to_jsonb(v_h::int) end))));
    elsif new.kind = 'file' then
      v_path := nullif(new.payload #>> '{file,path}', '');
      v_file_name := left(regexp_replace(coalesce(new.payload #>> '{file,name}', 'file'), '[^A-Za-z0-9._() -]', '_', 'g'), 180);
      v_file_mime := lower(left(coalesce(new.payload #>> '{file,mime}', 'application/octet-stream'), 120));
      if coalesce(new.payload #>> '{file,size}', '') ~ '^[0-9]{1,12}$' then v_file_size := greatest(0, least((new.payload #>> '{file,size}')::bigint, 10485760)); else v_file_size := 0; end if;
      if v_path is null or v_path not like 'groups/' || new.group_id::text || '/%' then raise exception 'ファイルの保存先が不正です'; end if;
      if v_file_mime not in ('application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/plain','text/csv','application/zip') then raise exception '対応していないファイル形式です'; end if;
      new.content := coalesce(nullif(btrim(new.content), ''), '[' || v_file_name || ']');
      new.payload := jsonb_build_object('v',1,'kind','file','file',jsonb_build_object('path',v_path,'name',v_file_name,'mime',v_file_mime,'size',v_file_size));
    else
      v_sticker_id := nullif(new.payload #>> '{sticker,id}', '');
      -- ① display を読み直す。compact 以外はすべて large に寄せる。
      v_sticker_display := case when new.payload #>> '{sticker,display}' = 'compact' then 'compact' else 'large' end;
      select label, asset_path into v_sticker_label, v_sticker_path
      from public.chat_stickers where id = v_sticker_id and is_active;
      if v_sticker_path is null then raise exception '利用できない感情イラストです'; end if;
      -- ② compact で本文があるときは、その本文を残す（上書きすると復元できない）。
      if v_sticker_display = 'compact' and nullif(btrim(new.content), '') is not null
        and new.content <> '[感情イラスト]' then
        new.content := left(new.content, 2000);
      else
        new.content := '[感情イラスト] ' || v_sticker_label;
      end if;
      new.payload := jsonb_build_object('v',1,'kind','sticker','sticker',
        jsonb_build_object('id',v_sticker_id,'label',v_sticker_label,'path',v_sticker_path,
          'display',v_sticker_display));
    end if;
  end if;
  if new.username is null then raise exception 'チャットのプロフィールがありません'; end if;
  if new.kind in ('card','image','sticker','file') and new.payload is null then raise exception 'このメッセージ種別には payload が必要です'; end if;
  if new.reply_to_id is not null and not exists (select 1 from public.chat_messages where id = new.reply_to_id and group_id = new.group_id) then raise exception '返信先の発言が同じトークルームにありません'; end if;
  if new.mentions is null then new.mentions := '{}'::uuid[];
  elsif array_length(new.mentions, 1) is not null then
    select coalesce(array_agg(distinct gm.user_id), '{}'::uuid[]) into new.mentions
    from public.chat_group_members gm where gm.group_id = new.group_id and gm.user_id = any(new.mentions);
  end if;
  new.created_at := now();
  return new;
end;
$fn$;
