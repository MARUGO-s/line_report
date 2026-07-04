-- 来客予測モデル(foodcourt-forecast-cron)がバックテストまで済ませて確定した「フィット済み係数」を保存する。
-- これまでAI解説(foodcourt_compare.ts)は、この予測モデルとは別に単純な単変量集計(buildConditionPatternStats)
-- で曜日/イベント/天気の傾向を計算していたが、二重管理になり、予測モデルの方が交互作用を考慮した乗算モデル・
-- 自己採点(MAPE)つきでより正確。ここに係数を書き出し、AI解説側も同じ「唯一の学習結果」を参照できるようにする。
create table if not exists public.foodcourt_forecast_factors (
  id             bigint generated always as identity primary key,
  tenant_name    text not null unique,       -- 'MARUGO S'（基準店のみ）
  model_version  text not null,
  mean_guests    numeric not null,
  wday_factors   jsonb not null,             -- {"1":係数,...,"7":係数}
  wday_counts    jsonb not null,             -- {"1":サンプル数,...}
  event_factors  jsonb not null,             -- {"soccer_pv":係数,"pro":係数,...}
  event_counts   jsonb not null,
  weather_factors jsonb not null,            -- {"rainy":係数,"dry":係数}
  weather_counts jsonb not null,
  median_spend   numeric,
  history_days   integer not null,
  backtest_days  integer not null,
  mape_guests    numeric,                    -- バックテスト自己採点（0.14 = 14%誤差）
  mape_sales     numeric,
  updated_at     timestamptz not null default now()
);

-- セキュリティ（恒久前提）: RLS有効・ポリシー無し（anon/authenticated不可、service_role=Edge Functions専用）。
alter table public.foodcourt_forecast_factors enable row level security;
grant select, insert, update, delete on public.foodcourt_forecast_factors to service_role;
