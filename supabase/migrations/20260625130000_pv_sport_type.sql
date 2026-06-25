-- ============================================================
-- PV(パブリックビューイング)の競技種別を構造化し、サッカーPVを別係数として扱えるようにする。
--
-- 運用知見: PV放映日はフードコート全体の集客は大きいが、特にサッカーは客がバーガー/ビールに流れ、
--   marugoS(ワイン/カレー)の売上寄与は「大集客の中のおこぼれ」が中心＝客数ほど売上は伸びない。
--   実測: 06-15 サッカー単独(5:00JST)=当店47人(平常以下)。06-21=244人だが同日ドーム野球が重なり野球＋日曜が主因。
--   → サッカーPVを野球より下位の独立係数で学習させ、過大評価を避ける（来客予測 foodcourt-forecast-cron）。
--
-- 追加:
--   - tokyo_dome_events.pv_sport : PV放映の競技 (soccer/baseball/boxing/olympic/other)。PV以外は null。
--   - foodcourt_daily_features に has_soccer_pv（サッカーPVがあるか）を追加。
-- 冪等: add column if not exists ／ create or replace view（新規列は末尾追加）。
-- ============================================================

alter table public.tokyo_dome_events add column if not exists pv_sport text;

create or replace view public.foodcourt_daily_features
with (security_invoker = true) as
select
  d.business_date,
  extract(isodow from d.business_date)::int as iso_dow,
  (extract(isodow from d.business_date) in (6,7)) as is_weekend,
  coalesce(ev.event_count, 0) as event_count,
  ev.categories,
  coalesce(ev.has_pro_baseball, false) as has_pro_baseball,
  coalesce(ev.has_live, false)         as has_live,
  coalesce(ev.has_ama_baseball, false) as has_ama_baseball,
  (coalesce(ev.event_count, 0) > 0)    as has_event,
  ev.max_expected_attendance,
  w.weather_code, w.temp_max, w.temp_min, w.precipitation_mm, w.precip_prob, w.summary,
  (coalesce(w.precipitation_mm, 0) >= 1) as is_rainy,
  coalesce(ev.has_sports_broadcast, false) as has_sports_broadcast,
  coalesce(ev.has_japan_match, false)      as has_japan_match,
  coalesce(ev.has_soccer_pv, false)        as has_soccer_pv   -- PV: サッカー放映があるか（当店はおこぼれ寄与）
from (
  select business_date from public.foodcourt_daily_facts
  union
  select event_date from public.tokyo_dome_events
  union
  select weather_date from public.weather_daily where location = 'tokyo_dome'
) d(business_date)
left join lateral (
  select count(*) as event_count,
         string_agg(distinct e.category, ',') as categories,
         bool_or(e.category = 'プロ野球') as has_pro_baseball,
         bool_or(e.category = 'ライブ')   as has_live,
         bool_or(e.category = 'アマ野球') as has_ama_baseball,
         bool_or(e.category = 'スポーツ中継') as has_sports_broadcast,
         bool_or(e.is_japan = true)         as has_japan_match,
         bool_or(e.pv_sport = 'soccer')     as has_soccer_pv,
         max(e.expected_attendance)       as max_expected_attendance
  from public.tokyo_dome_events e
  where e.event_date = d.business_date
) ev on true
left join public.weather_daily w on w.weather_date = d.business_date and w.location = 'tokyo_dome';

grant select on public.foodcourt_daily_features to service_role;
