-- Journal Report AIチャットで「PDFにする」押下時に、質問と回答を店舗スコープで保存する。
-- 公開Pagesは直接参照せず、admin-api（service_role）経由のみで一覧・保存・削除する。

create table if not exists public.ai_chat_pdf_history (
  id text primary key,
  store_partition_key text not null,
  question text not null,
  answer text not null,
  mode text,
  provider text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_chat_pdf_history_question_not_blank check (length(btrim(question)) > 0),
  constraint ai_chat_pdf_history_answer_not_blank check (length(btrim(answer)) > 0)
);

create index if not exists ai_chat_pdf_history_store_created_idx
  on public.ai_chat_pdf_history (store_partition_key, created_at desc);

alter table public.ai_chat_pdf_history enable row level security;

revoke all on table public.ai_chat_pdf_history from anon, authenticated;
grant select, insert, update, delete on table public.ai_chat_pdf_history to service_role;

comment on table public.ai_chat_pdf_history is
  'Journal Report AIチャットのPDF保存履歴（質問＋回答）。admin-api経由のみ。';
