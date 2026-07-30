-- jnl2txt 売上予測スナップショット
-- 予測完了時に保存し、後から実績（saved_reports）と比較して MAPE を算出する。

create table if not exists public.sales_forecasts (
  id text primary key,
  store_partition_key text not null default 'bistrocavacava',
  title text not null default '売上予測',
  horizon_months integer not null default 3,
  forecasted_at timestamptz not null default now(),
  method text,
  confidence text,
  history_snapshot jsonb not null default '[]'::jsonb,
  forecasts jsonb not null default '[]'::jsonb,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sales_forecasts_store_created_idx
  on public.sales_forecasts (store_partition_key, created_at desc);

create index if not exists sales_forecasts_store_forecasted_idx
  on public.sales_forecasts (store_partition_key, forecasted_at desc);

alter table public.sales_forecasts enable row level security;

revoke all on table public.sales_forecasts from anon, authenticated;
grant select, insert, update, delete on table public.sales_forecasts to service_role;
