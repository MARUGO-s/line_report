-- Keep/アルバム導入時に残った3点の後始末。

-- ① 消えた revoke を戻す ------------------------------------------------------
--
-- 20260827010000 の
--   grant usage, select on all sequences in schema public to authenticated;
-- が、20260820210000 で意図的に外していた権限まで復活させていた。
--
--   revoke all on sequence public.chat_push_delivery_diagnostics_id_seq
--     from public, anon, authenticated;
--
-- テーブル本体の revoke は生きているので行は読めないが、連番の last_value
-- （＝診断行の累積件数）が読め、nextval() でIDを消費できる状態だった。
-- 元の意図どおり service_role だけに戻す。
--
-- 残り171本は Supabase の既定（anon にも同じ権限がある）なので触らない。
-- Keep/アルバムの3表は identity 列で、挿入にシーケンス権限は要らない。

revoke all on sequence public.chat_push_delivery_diagnostics_id_seq
  from public, anon, authenticated;
grant usage, select on sequence public.chat_push_delivery_diagnostics_id_seq
  to service_role;

-- ② アルバムの updated_at を実際に動かす --------------------------------------
--
-- 一覧は updated_at desc で並べるが、これを更新する処理がどこにも無く、
-- 既定値（作成時刻）のままだった。写真を出し入れしたら親を触る。
--
-- chat_albums の UPDATE ポリシーは管理者限定なので、一般メンバーが写真を
-- 追加しても更新できるよう security definer にする。

create or replace function public.chat_touch_album()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- DELETE では NEW が未割当なので、参照すると実行時エラーになる。
  -- TG_OP で分けて、触る行を明示する。
  if tg_op = 'DELETE' then
    update public.chat_albums set updated_at = now() where id = old.album_id;
    return old;
  end if;
  update public.chat_albums set updated_at = now() where id = new.album_id;
  return new;
end;
$fn$;

revoke all on function public.chat_touch_album() from public, anon, authenticated;

drop trigger if exists chat_album_items_touch on public.chat_album_items;
create trigger chat_album_items_touch
after insert or delete on public.chat_album_items
for each row execute function public.chat_touch_album();

-- ③ 購読されていない Realtime 配信を外す ---------------------------------------
--
-- publication には入れたが、chat.html 側に postgres_changes の購読が無い。
-- アルバムはモーダルを開くたび loadAlbums() で取り直すため、開いた時点の
-- 内容は常に最新。消費者のいないWAL配信をやめる。
--
-- 将来ライブ同期したくなったら、購読の追加に加えて replica identity full が
-- 要る。既定のままだと DELETE の old_record が主キーだけになり、RLS が
-- group_id を評価できずイベントが配信されない（リアクションと同じ論点）。

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='chat_album_items'
  ) then alter publication supabase_realtime drop table public.chat_album_items; end if;
  if exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='chat_albums'
  ) then alter publication supabase_realtime drop table public.chat_albums; end if;
end $$;
