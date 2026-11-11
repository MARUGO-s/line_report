-- 食べログ・一休の週報を、M-talk に加えて LINE グループへ送るためのオプトインと重複防止。
-- 既定は false。この migration では既存ルームを有効化しない（承認後に対象グループだけ true にする）。
-- 例: BISTRO CAVA CAVA の LINE グループ「Cava Cava」（store_partition_key = bistrocavacava）。

alter table public.room_summary_settings
  add column if not exists gourmet_weekly_line_enabled boolean not null default false;

comment on column public.room_summary_settings.gourmet_weekly_line_enabled is
  'true のとき、gourmet 週報の POST /store-post が line: true なら、この LINE ルーム（C…/R…）へカード本文と週報HTMLリンクを1通だけ送る。既定 false。PDFは送らない。';

create table if not exists public.gourmet_weekly_line_sends (
  room_id text not null,
  dedupe_key text not null,
  store_partition_key text,
  sent_at timestamptz not null default now(),
  constraint pk_gourmet_weekly_line_sends primary key (room_id, dedupe_key)
);

comment on table public.gourmet_weekly_line_sends
  is 'gourmet 週報の LINE 送信予約（ルーム×dedupe_key で1回のみ）。再実行しても二重送信しない。';

alter table public.gourmet_weekly_line_sends enable row level security;
grant select, insert, update, delete on public.gourmet_weekly_line_sends to service_role;
