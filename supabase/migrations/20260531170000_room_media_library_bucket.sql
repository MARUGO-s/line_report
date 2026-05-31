-- 「メディア閲覧」用にルーム受信メディアを保存する基盤
--   - 保存先 private バケット line-media を用意（単体上限 21MB）
--   - 既存 line_message_media に webhook から最小列で挿入できるよう message_id を NULL 許容化
--   - ルーム別の容量超過削除（古い順）クエリ用インデックス
-- 1ルームあたり合計 20MB を超えた分は、アプリ側（line_media_store.ts）が古い順に自動削除する。

insert into storage.buckets (id, name, public, file_size_limit)
values ('line-media', 'line-media', false, 22020096)
on conflict (id) do nothing;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'line_message_media'
      and column_name = 'message_id'
  ) then
    execute 'alter table public.line_message_media alter column message_id drop not null';
  end if;
end $$;

create index if not exists line_message_media_room_created_idx
  on public.line_message_media (room_id, created_at);
