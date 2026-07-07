-- 来客予測モデルに「モデル自動選択ループ」を追加したことに伴う追加カラム。
-- foodcourt-forecast-cronは毎晩、レガシー乗算モデル(mult-factor-v1)とポアソン回帰(glm-poisson-v1、
-- 曜日/イベント種別/天気/log(予想動員数)/トレンドを説明変数、リッジ正則化)をバックテストで比較し、
-- guestsのMAPEが小さい方を forecast_predictions の実際の予測に採用する。
--
-- AI解説(foodcourt_compare.ts)向けの wday_factors/event_factors/weather_factors/mape_guests/mape_sales は
-- 従来どおり常にレガシー乗算モデルの値のまま維持する（解釈しやすい「倍率」の形を保つため）。
-- 実際にどちらが採用されたかの透明性のための記録として、この列を追加する。
alter table public.foodcourt_forecast_factors
  add column if not exists model_selection jsonb;

comment on column public.foodcourt_forecast_factors.model_selection is
  '{chosen, glm_wins, glm_lambda, legacy_mape_guests, glm_mape_guests}。foodcourt-forecast-cronが毎晩バックテストで比較し、forecast_predictions生成時にどちらを採用したかの記録（AI解説の係数はレガシー固定・これは実際に使われたモデルの透明性用）。';
