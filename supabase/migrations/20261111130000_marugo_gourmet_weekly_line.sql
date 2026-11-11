-- ============================================================
-- MARUGO S グルメサイト週報（HTML）のリンクを LINE グループ「マルゴエス運営チーム」へ送る。
-- 送るのは Edge Function `marugo-gourmet-weekly-line`（共有の作業用コンピューターの
-- scripts/marugo-gourmet-weekly.sh から、毎週土曜 10:00 ごろ呼ばれる）。
--
-- 1) 呼び出し用キーの照合表: キーそのものは保存しない。SHA-256 の hex だけを持つ。
--    行はこの migration では入れない（運用者が SQL で 1 行だけ入れる。キーは作業用コンピューターの
--    ~/.marugo-line/gourmet_weekly_key に置く）。行が無ければ関数はすべて 401。
-- 2) 二重送信防止: 週報の日付ごとに 1 回だけ（送信前に確保し、失敗したら消す）。
-- ============================================================

create table if not exists public.marugo_gourmet_weekly_line_auth (
  id smallint primary key default 1 check (id = 1),
  key_sha256 text not null check (key_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
comment on table public.marugo_gourmet_weekly_line_auth
  is 'marugo-gourmet-weekly-line の呼び出しキーの SHA-256（hex）。キー本体は保存しない。1行のみ。';
alter table public.marugo_gourmet_weekly_line_auth enable row level security;
revoke all on public.marugo_gourmet_weekly_line_auth from public, anon, authenticated;
grant select, insert, update, delete on public.marugo_gourmet_weekly_line_auth to service_role;

create table if not exists public.marugo_gourmet_weekly_line_sends (
  report_date date not null,
  room_id text not null,
  report_url text not null,
  store_partition_key text,
  sent_at timestamptz not null default now(),
  constraint pk_marugo_gourmet_weekly_line_sends primary key (room_id, report_date)
);
comment on table public.marugo_gourmet_weekly_line_sends
  is 'MARUGO S グルメサイト週報の LINE 送信記録（ルーム×週報の日付で1回のみ）。';
alter table public.marugo_gourmet_weekly_line_sends enable row level security;
revoke all on public.marugo_gourmet_weekly_line_sends from public, anon, authenticated;
grant select, insert, update, delete on public.marugo_gourmet_weekly_line_sends to service_role;
