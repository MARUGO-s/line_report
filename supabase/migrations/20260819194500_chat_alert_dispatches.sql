-- トーク通知の単独配信ログ。LINE の成否と切り離して重複投稿を防ぐ。

create table if not exists public.chat_alert_dispatches (
  id bigint generated always as identity primary key,
  kind text not null,
  chat_group_id bigint not null references public.chat_groups(id) on delete cascade,
  dedupe_key text not null,
  message_id bigint references public.chat_messages(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (kind, chat_group_id, dedupe_key)
);

create index if not exists idx_chat_alert_dispatches_group_created
  on public.chat_alert_dispatches (chat_group_id, created_at desc);

alter table public.chat_alert_dispatches enable row level security;

comment on table public.chat_alert_dispatches is
  'トーク予約通知の単独配信記録。LINE 成功を待たずに送り、同じキーの再送を防ぐ。';
