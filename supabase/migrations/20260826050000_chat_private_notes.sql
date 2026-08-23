-- 個人メモ機能。
--
-- ルームのタイムライン上に挟める、本人にだけ表示される私的な注記。
-- 既存の「#メモ」（店舗ルームで送信してJournal Reportの資料へ登録する機能）
-- とは無関係の別機能。#メモは送信して他の参加者・Botに見えるのに対し、
-- 個人メモは他の参加者へは一切送信・表示されない。名称の混同を避けるため
-- 画面上は「個人メモ」と表示する。
--
-- 要件:
--   - 送信は一切行わない。他の参加者・Bot・管理画面・Web Pushのいずれにも見えない。
--   - 本人が見れば、同じルームの同じ端末でも別の端末でも同じ内容が見える（DB保存）。
--   - 本人が削除できる。編集は今回のスコープに含めない。

create table if not exists public.chat_private_notes (
  id bigint primary key generated always as identity,
  group_id bigint not null references public.chat_groups(id) on delete cascade,
  user_id uuid not null references public.chat_users(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now(),
  constraint chat_private_notes_content_length check (char_length(content) between 1 and 500)
);

comment on table public.chat_private_notes is
  '個人メモ。ルームのタイムライン上に本人にだけ表示される私的な注記。送信は行わず、他の参加者・Bot・管理画面のいずれからも見えない。';
comment on column public.chat_private_notes.content is
  '本人だけが読む注記。他の参加者・Botには一切送信・表示しない。';

create index if not exists idx_chat_private_notes_user_group
  on public.chat_private_notes (user_id, group_id, created_at);

alter table public.chat_private_notes enable row level security;

-- 以下すべて to authenticated。anon にはポリシーを与えない＝全拒否。
-- 更新(update)ポリシーは意図的に作らない。編集は今回のスコープ外。

create policy chat_private_notes_select_own on public.chat_private_notes
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy chat_private_notes_insert_own on public.chat_private_notes
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and public.chat_can_view_group(group_id)
  );

create policy chat_private_notes_delete_own on public.chat_private_notes
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- Realtime: 本人の別端末・別タブへ同期するため、削除も含めて配信する。
-- DELETEは主キー(id)しかpayloadに載らないが、既存のchat_messagesの
-- 削除処理と同様、idだけで手元の一覧から取り除けるため replica identity の
-- 変更は不要（現在表示中のルームの分しか保持していないため）。
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'chat_private_notes'
  ) then
    alter publication supabase_realtime add table public.chat_private_notes;
  end if;
end
$$;
