-- M-talkへ投稿された画像をメニュー資料として解析したあと、利用者が
-- 「資料へ登録」を押すまで原本・解析結果を下書きとして保持する。
-- ブラウザからは直接読書きさせず、chat-knowledge（解析）と
-- admin-api（本人JWTでの登録/見送り）だけがservice_roleで扱う。

create table if not exists public.chat_menu_knowledge_drafts (
  id uuid primary key default gen_random_uuid(),
  group_id bigint not null references public.chat_groups(id) on delete cascade,
  source_message_id bigint not null references public.chat_messages(id) on delete cascade,
  card_message_id bigint references public.chat_messages(id) on delete set null,
  requested_by uuid not null references public.chat_users(id) on delete cascade,
  resolved_by uuid references public.chat_users(id) on delete set null,
  store_partition_key text not null check (char_length(btrim(store_partition_key)) between 1 and 80),
  image_storage_path text not null check (image_storage_path <> ''),
  image_mime_type text not null default 'image/jpeg',
  analysis jsonb not null check (jsonb_typeof(analysis) = 'object'),
  status text not null default 'pending'
    check (status in ('pending', 'registering', 'registered', 'declined', 'failed')),
  result_document_id bigint references public.store_knowledge_documents(id) on delete set null,
  last_error text,
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (source_message_id)
);

create index if not exists chat_menu_knowledge_drafts_group_status_idx
  on public.chat_menu_knowledge_drafts (group_id, status, created_at desc);
create index if not exists chat_menu_knowledge_drafts_expiry_idx
  on public.chat_menu_knowledge_drafts (expires_at)
  where status = 'pending';

alter table public.chat_menu_knowledge_drafts enable row level security;
revoke all on table public.chat_menu_knowledge_drafts from public, anon, authenticated;
grant select, insert, update, delete on table public.chat_menu_knowledge_drafts to service_role;

comment on table public.chat_menu_knowledge_drafts is
  'M-talk画像のメニュー解析結果。利用者がカードで承認するまで店舗ナレッジへ登録しない。';
comment on column public.chat_menu_knowledge_drafts.analysis is
  'admin-apiの店舗ナレッジ画像解析と同じ正規化済み結果。クライアント入力を保存しない。';
