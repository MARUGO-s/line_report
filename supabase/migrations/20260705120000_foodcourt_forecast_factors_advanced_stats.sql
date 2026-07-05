-- 統計拡張: 信頼区間・分位数・交互作用・残差バイアス・効果量を1つのjsonbに保存する。
-- 予測モデル(mult-factor-v1)の係数・予測値には影響しない（AI解説の解釈コンテキスト専用）。
alter table public.foodcourt_forecast_factors
  add column if not exists advanced_stats jsonb;

comment on column public.foodcourt_forecast_factors.advanced_stats is
  'stats-ext-v1: {factor_ci, quantiles, interactions, residual_bias, effect_sizes}。foodcourt-forecast-cronが毎晩再計算。AI解説(buildForecastFactorsContext)が読む。';
