-- chat.html に「画像送信」と「本文検索」を足す。
--
--   ① chat_messages.kind に 'image' を追加。payload に Storage のパスを持つ。
--   ② 画像は非公開バケット chat-images に置き、表示のたびに署名URLを作る。
--      レシートや予約表など顧客名の写った写真が流れる前提なので、
--      アイコン(chat-icons)と違って公開URLにはしない。
--   ③ 本文検索用のインデックス。

-- ① kind に image を許可 --------------------------------------------------

alter table public.chat_messages
  drop constraint if exists chat_messages_kind_check;

alter table public.chat_messages
  add constraint chat_messages_kind_check check (kind in ('text', 'card', 'image'));

-- クライアントが作れるのは text と image だけ。card は service_role 専用のまま。
-- image の payload は信用せず、この関数で作り直してから保存する
-- （余計なキーを落とし、パスが必ず自分の送信先グループ配下であることを強制する）。
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
begin
  if auth.uid() is not null then
    new.user_id := auth.uid();
    select username into new.username from public.chat_users where id = auth.uid();

    if new.kind is null or new.kind not in ('text', 'image') then
      new.kind := 'text';
    end if;

    if new.kind = 'text' then
      new.payload := null;
    else
      v_path := nullif(new.payload #>> '{image,path}', '');
      if v_path is null or v_path not like 'groups/' || new.group_id::text || '/%' then
        raise exception '画像メッセージの保存先が不正です';
      end if;

      -- 数字以外を落としてから整数化する（不正値で例外にしない）。
      v_w := nullif(regexp_replace(coalesce(new.payload #>> '{image,w}', ''), '\D', '', 'g'), '');
      v_h := nullif(regexp_replace(coalesce(new.payload #>> '{image,h}', ''), '\D', '', 'g'), '');

      new.payload := jsonb_strip_nulls(jsonb_build_object(
        'v', 1,
        'kind', 'image',
        'image', jsonb_strip_nulls(jsonb_build_object(
          'path', v_path,
          'w', case when v_w is null then null else to_jsonb(v_w::int) end,
          'h', case when v_h is null then null else to_jsonb(v_h::int) end
        ))
      ));
    end if;
  end if;

  if new.username is null then
    raise exception 'チャットのプロフィールがありません';
  end if;

  if new.kind in ('card', 'image') and new.payload is null then
    raise exception 'このメッセージ種別には payload が必要です';
  end if;

  new.created_at := now();
  return new;
end;
$fn$;

-- ② 画像バケット（非公開） --------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-images',
  'chat-images',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- パスの2階層目をグループIDとして解釈する。AND の評価順は保証されないので、
-- 数字判定と bigint キャストは CASE で必ず順序どおりに評価する
-- （groups/abc/… のようなパスでキャスト例外を投げないため）。
create or replace function public.chat_is_member_path(p_folder text)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select case
    when p_folder ~ '^[0-9]+$' then public.chat_is_member(p_folder::bigint)
    else false
  end
$fn$;

revoke all on function public.chat_is_member_path(text) from public, anon;
grant execute on function public.chat_is_member_path(text) to authenticated;

-- 読み書きできるのは、そのグループの参加者だけ。
-- パスは groups/<group_id>/<uuid>.<ext> 固定。
drop policy if exists chat_images_select on storage.objects;
create policy chat_images_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'chat-images'
    and (storage.foldername(name))[1] = 'groups'
    and public.chat_is_member_path((storage.foldername(name))[2])
  );

drop policy if exists chat_images_insert on storage.objects;
create policy chat_images_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'chat-images'
    and (storage.foldername(name))[1] = 'groups'
    and public.chat_is_member_path((storage.foldername(name))[2])
  );

-- 発言と同じく画像も消させない（追記のみ）。update/delete のポリシーは作らない。

-- ③ 本文検索 ----------------------------------------------------------------
--
-- 語順や活用を無視して素朴に部分一致させたいので、全文検索ではなく
-- ILIKE '%…%' を使う。日本語は空白で区切られず to_tsvector が効きにくいため。
-- pg_trgm の GIN インデックスで前方一致以外も引けるようにする。

-- このプロジェクトの pg_trgm は public スキーマに入っている（extensions ではない）。
-- 演算子クラスも public.gin_trgm_ops なので、スキーマを決め打ちせず実際の場所を引く。
do $$
declare
  v_schema text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_trgm') then
    create extension pg_trgm with schema extensions;
  end if;

  select n.nspname into v_schema
  from pg_opclass o
  join pg_namespace n on n.oid = o.opcnamespace
  join pg_am m on m.oid = o.opcmethod
  where o.opcname = 'gin_trgm_ops' and m.amname = 'gin'
  limit 1;

  if v_schema is null then
    raise exception 'gin_trgm_ops が見つかりません';
  end if;

  execute format(
    'create index if not exists idx_chat_messages_content_trgm
       on public.chat_messages using gin (content %I.gin_trgm_ops)',
    v_schema
  );
end
$$;

comment on index public.idx_chat_messages_content_trgm is
  'トーク検索の ILIKE ''%…%'' 用。日本語は to_tsvector が効かないため全文検索ではなく trigram。';
