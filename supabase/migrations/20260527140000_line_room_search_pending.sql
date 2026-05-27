-- LINE トーク内検索の待ち受け（種別選択後のキーワード入力）

create table if not exists public.line_room_search_pending (
  room_id text not null,
  user_id text not null,
  search_kind text not null,
  updated_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

comment on table public.line_room_search_pending is
  'LINE 会話検索ボット: 検索種別選択後、次メッセージでキーワード／日付を受け取る';

create index if not exists line_room_search_pending_updated_idx
  on public.line_room_search_pending (updated_at desc);

alter table public.line_room_search_pending enable row level security;
