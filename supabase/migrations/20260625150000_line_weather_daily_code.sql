-- ============================================================
-- analytics.html の天気アイコンを正確にするため、キャッシュ line_weather_daily に
-- WMO weather_code を保存できるようにする。
--
-- 従来アイコンは降水量・気温のみ（weatherIcon(rain,temp)）で判定していたため、
-- 降水0でも曇りの日が気温次第で晴れ寄りに出る癖があった。Open-Meteo の daily=weather_code を
-- 取得・保存し、画面はコード優先で晴れ/曇り/雨/雪/雷を判定する（rain/temp はフォールバック）。
-- 冪等: add column if not exists。
-- ============================================================

alter table public.line_weather_daily add column if not exists weather_code integer;
