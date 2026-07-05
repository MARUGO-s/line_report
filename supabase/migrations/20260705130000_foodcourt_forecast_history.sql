-- 学習の進化トラッキング: 毎晩の学習結果(履歴日数・MAPE)を追記保存し、
-- 「モデルが本当に賢くなっているか」を時系列で検証可能にする。
-- foodcourt_forecast_factors は最新1行を上書きするため、進化の軌跡はこのテーブルが正本。
create table if not exists public.foodcourt_forecast_history (
  id bigint generated always as identity primary key,
  tenant_name text not null,
  log_date date not null,
  model_version text not null,
  history_days integer not null,
  backtest_days integer not null,
  mape_guests numeric,
  mape_sales numeric,
  mean_guests numeric,
  created_at timestamptz not null default now(),
  unique (tenant_name, log_date)
);
alter table public.foodcourt_forecast_history enable row level security;
grant select, insert, update, delete on public.foodcourt_forecast_history to service_role;
