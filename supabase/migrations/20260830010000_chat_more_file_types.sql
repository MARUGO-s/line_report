-- 添付できる形式を増やし、上限を 10MB → 25MB へ。
--
--   ① PowerPoint (.ppt/.pptx)  … Word/Excel はあるのに抜けていた
--   ② HEIC/HEIF                … iPhone の「高効率」設定で出てくる写真
--   ③ 上限 25MB                … ページ数の多いPDFやスキャン資料が 10MB を超える
--
-- HEIC は画像扱いにしない。ブラウザ（Safari以外）が復号できず canvas での
-- 縮小が失敗するため、クライアント側でも原本のままファイルとして送る。
--
-- text/html と image/svg+xml は引き続き除外する。署名URLで開いた際に
-- スクリプトが動くのを防ぐため。

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-images', 'chat-images', false, 26214400,
  array[
    'image/jpeg','image/png','image/webp','image/gif',
    'image/heic','image/heif',
    'application/pdf','application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain','text/csv','application/zip'
  ]::text[]
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- トリガ側の許可リストと上限も合わせる。
-- 20260829010000 の内容（スタンプの display / compact 本文保持、メンションの
-- メンバー絞り込み、返信先検証）はそのまま維持する。
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
      if coalesce(new.payload #>> '{file,size}', '') ~ '^[0-9]{1,12}$' then v_file_size := greatest(0, least((new.payload #>> '{file,size}')::bigint, 26214400)); else v_file_size := 0; end if;
      if v_path is null or v_path not like 'groups/' || new.group_id::text || '/%' then raise exception 'ファイルの保存先が不正です'; end if;
      if v_file_mime not in (
        'image/heic','image/heif',
        'application/pdf','application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain','text/csv','application/zip'
      ) then raise exception '対応していないファイル形式です'; end if;
      new.content := coalesce(nullif(btrim(new.content), ''), '[' || v_file_name || ']');
      new.payload := jsonb_build_object('v',1,'kind','file','file',jsonb_build_object('path',v_path,'name',v_file_name,'mime',v_file_mime,'size',v_file_size));
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
      new.payload := jsonb_build_object('v',1,'kind','sticker','sticker',
        jsonb_build_object('id',v_sticker_id,'label',v_sticker_label,'path',v_sticker_path,'display',v_sticker_display));
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
