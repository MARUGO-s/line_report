-- フードコート「テナント一覧」レポート（v2.mallpro.jp）の抽出結果を保存する（分析専用・売上には登録しない）。
-- マルゴS等フードコート内店舗が毎日送る全テナントの売上/客数を貯め、基準店=100の比較・推移に使う。
create table if not exists public.foodcourt_tenant_reports (
  id bigserial primary key,
  store_partition_key text not null,                 -- 受信店舗（例: marugoS）
  room_id text,
  line_message_id text unique,                        -- 同一画像の再送をべき等化
  report_date date,                                   -- 集計対象日（取れなければ null）
  base_tenant_name text,                              -- 比較の基準店（例: MARUGO S）
  tenants jsonb not null,                             -- [{name, code, sales, guests}]
  created_at timestamptz not null default now()
);

create index if not exists foodcourt_tenant_reports_store_idx
  on public.foodcourt_tenant_reports (store_partition_key, created_at desc);

comment on table public.foodcourt_tenant_reports is
  'フードコート テナント一覧レポートの抽出結果（分析専用・売上非登録）。基準店=100の比較/推移に使う。';

-- RLS: service role(Edge Functions)のみ書き込み・参照。anon/authenticated には公開しない（店舗横断データのため）。
alter table public.foodcourt_tenant_reports enable row level security;
