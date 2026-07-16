-- 予測精度の評価指標をMAPE中心からWAPE/MAE併用へ拡張する。
-- WAPEは売上・客数が大きい日を自然に重く扱うため、経営判断に近いモデル選択指標として使う。
alter table public.foodcourt_forecast_history
  add column if not exists wape_guests numeric,
  add column if not exists wape_sales numeric,
  add column if not exists mae_guests numeric,
  add column if not exists mae_sales numeric,
  add column if not exists rolling_wape_guests numeric,
  add column if not exists rolling_wape_sales numeric,
  add column if not exists rolling_mae_guests numeric,
  add column if not exists rolling_mae_sales numeric;

comment on column public.foodcourt_forecast_history.wape_guests is
  '客数WAPE = sum(abs(predicted-actual))/sum(actual)。小さい実績日のMAPE過大評価を避ける補助指標。';
comment on column public.foodcourt_forecast_history.wape_sales is
  '売上WAPE = sum(abs(predicted-actual))/sum(actual)。foodcourt-forecast-cron v2 の主なモデル選択指標。';
comment on column public.foodcourt_forecast_history.mae_guests is
  '客数MAE。予測客数の平均絶対誤差（人）。';
comment on column public.foodcourt_forecast_history.mae_sales is
  '売上MAE。予測売上の平均絶対誤差（円）。';
comment on column public.foodcourt_forecast_history.rolling_wape_guests is
  '直近ホールドアウト期間の客数WAPE。';
comment on column public.foodcourt_forecast_history.rolling_wape_sales is
  '直近ホールドアウト期間の売上WAPE。';
comment on column public.foodcourt_forecast_history.rolling_mae_guests is
  '直近ホールドアウト期間の客数MAE（人）。';
comment on column public.foodcourt_forecast_history.rolling_mae_sales is
  '直近ホールドアウト期間の売上MAE（円）。';
