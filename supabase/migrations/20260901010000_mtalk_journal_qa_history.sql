-- M-talk の「電子ジャーナルに聞く」を続きの質問に対応させるための会話履歴。
--
-- ジャーナル画面のQ&Aは直近8往復を history として /pos-journals/ai-ask へ渡し、
-- 「じゃあ前月は？」のような続きが通る。M-talk は毎回1問1答で文脈が無かった。
--
-- 画面は画面を開いている間だけ保持するが、チャットはいつでも続きを送れるので、
-- 保持先が要る。参照するのは直近8往復かつ2時間以内だけ（下の取得側で絞る）。
-- 何日も前の文脈を引きずると、別件の質問に前の月の話が混ざる。

create table if not exists public.mtalk_journal_qa_history (
  id bigint primary key generated always as identity,
  group_id bigint not null references public.chat_groups(id) on delete cascade,
  user_id uuid not null references public.chat_users(id) on delete cascade,
  role text not null
    constraint mtalk_journal_qa_history_role_check check (role in ('user', 'assistant')),
  content text not null
    constraint mtalk_journal_qa_history_content_check
      check (btrim(content) <> '' and char_length(content) <= 4000),
  created_at timestamptz not null default now()
);

comment on table public.mtalk_journal_qa_history is
  'M-talkの電子ジャーナルQ&Aの会話履歴。/pos-journals/ai-ask へ渡す history の元。1対1トークのみ。';

create index if not exists idx_mtalk_journal_qa_history_lookup
  on public.mtalk_journal_qa_history (group_id, user_id, created_at desc);

-- 質問文と回答が入るため、一般利用者からは触らせない。
-- 書くのも読むのも chat-knowledge（service_role）だけ。
alter table public.mtalk_journal_qa_history enable row level security;
revoke all on table public.mtalk_journal_qa_history from public, anon, authenticated;
grant select, insert, delete on table public.mtalk_journal_qa_history to service_role;

-- 際限なく溜めない。1対1×利用者ごとに直近32行(=16往復)だけ残す。
create or replace function public.mtalk_journal_qa_history_prune()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  delete from public.mtalk_journal_qa_history h
  where h.group_id = new.group_id
    and h.user_id = new.user_id
    and h.id not in (
      select id from public.mtalk_journal_qa_history
      where group_id = new.group_id and user_id = new.user_id
      order by created_at desc, id desc
      limit 32
    );
  return null;
end;
$fn$;

revoke all on function public.mtalk_journal_qa_history_prune() from public, anon, authenticated;

drop trigger if exists mtalk_journal_qa_history_prune_trg on public.mtalk_journal_qa_history;
create trigger mtalk_journal_qa_history_prune_trg
after insert on public.mtalk_journal_qa_history
for each row execute function public.mtalk_journal_qa_history_prune();
