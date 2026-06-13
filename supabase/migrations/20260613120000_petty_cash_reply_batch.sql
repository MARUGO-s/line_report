-- レジ出金（経費）レシートを連続送信したとき、別々のwebhookで届く画像を数秒バッファして
-- 1返信（カルーセル）にまとめるためのバッファ。サービスロール(Edge Function)専用。
create table if not exists public.petty_cash_reply_batch (
  id                    bigserial primary key,
  store_partition_key   text not null,
  room_id               text not null,
  user_id               text,
  pending_id            bigint not null,
  supplier              text,
  amount_yen            integer not null default 0,
  line_message_id       text,
  reply_token           text not null,
  sent                  boolean not null default false,
  created_at            timestamptz not null default now(),
  sent_at               timestamptz
);
-- 「ルームの未送信を新しい順に」「未送信をまとめて claim」両方で効くインデックス。
create index if not exists petty_cash_reply_batch_room_unsent_idx
  on public.petty_cash_reply_batch (room_id, sent, id);

-- クライアント(anon)からは触らない。Edge Function は service_role なので影響なし。
alter table public.petty_cash_reply_batch enable row level security;
