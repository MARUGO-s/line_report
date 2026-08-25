-- M-talk: PDF / Office / text / archive attachments in the same private chat bucket.
-- The bucket remains private and the existing membership-scoped storage policies
-- continue to protect every file under groups/<group_id>/.

alter table public.chat_messages drop constraint if exists chat_messages_kind_check;
alter table public.chat_messages
  add constraint chat_messages_kind_check check (kind in ('text', 'card', 'image', 'sticker', 'file'));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-images', 'chat-images', false, 10485760,
  array[
    'image/jpeg','image/png','image/webp','image/gif',
    'application/pdf','application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain','text/csv','application/zip'
  ]::text[]
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

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
  v_file_name text;
  v_file_mime text;
  v_file_size bigint;
begin
  if auth.uid() is not null then
    new.user_id := auth.uid();
    select username into new.username from public.chat_users where id = auth.uid();
    if new.kind is null or new.kind not in ('text','image','sticker','file') then new.kind := 'text'; end if;
    if new.kind = 'text' then
      new.payload := null;
    elsif new.kind = 'image' then
      v_path := nullif(new.payload #>> '{image,path}', '');
      if v_path is null or v_path not like 'groups/' || new.group_id::text || '/%' then
        raise exception '画像メッセージの保存先が不正です';
      end if;
      v_w := nullif(regexp_replace(coalesce(new.payload #>> '{image,w}', ''), '\D', '', 'g'), '');
      v_h := nullif(regexp_replace(coalesce(new.payload #>> '{image,h}', ''), '\D', '', 'g'), '');
      new.payload := jsonb_strip_nulls(jsonb_build_object('v',1,'kind','image','image',
        jsonb_strip_nulls(jsonb_build_object('path',v_path,
          'w',case when v_w is null then null else to_jsonb(v_w::int) end,
          'h',case when v_h is null then null else to_jsonb(v_h::int) end))));
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
      select label, asset_path into v_sticker_label, v_sticker_path from public.chat_stickers where id = v_sticker_id and is_active;
      if v_sticker_path is null then raise exception '利用できない感情イラストです'; end if;
      new.content := '[感情イラスト] ' || v_sticker_label;
      new.payload := jsonb_build_object('v',1,'kind','sticker','sticker',jsonb_build_object('id',v_sticker_id,'label',v_sticker_label,'path',v_sticker_path));
    end if;
  end if;
  if new.username is null then raise exception 'チャットのプロフィールがありません'; end if;
  if new.kind in ('card','image','sticker','file') and new.payload is null then raise exception 'このメッセージ種別には payload が必要です'; end if;
  if new.reply_to_id is not null and not exists (select 1 from public.chat_messages where id = new.reply_to_id and group_id = new.group_id) then raise exception '返信先の発言が同じトークルームにありません'; end if;
  if new.mentions is null then new.mentions := '{}'::uuid[]; end if;
  new.created_at := now();
  return new;
end;
$fn$;

comment on column public.chat_messages.payload is 'M-talkの画像、ファイル、スタンプ、カードの正規化済みペイロード';
