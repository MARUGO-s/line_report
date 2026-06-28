-- 予測特徴量ビューに has_dome_main（その日に東京ドーム本体=venue 'tokyo-dome' の催しがあるか）を追加。
--
-- 背景: 来客予測モデルは has_live 等の種別フラグで係数を学習するが、会場規模を区別しないため
--   「東京ドーム本体コンサート(大集客)」と「カナデビア等の小ホールのライブ(小集客)」が同じ "live" 係数になり、
--   小ホール単独日まで過大予測していた。会場フラグを足し、forecast-cron 側で
--   live&&dome→"live"(大) / dome本体その他→"dome" / 小ホールのみ→"hall"(小) に分離する。
-- 冪等: CREATE OR REPLACE（既存列は同順で保持し has_dome_main を末尾に追加）。
create or replace view public.foodcourt_daily_features as
 SELECT d.business_date,
    EXTRACT(isodow FROM d.business_date)::integer AS iso_dow,
    EXTRACT(isodow FROM d.business_date) = ANY (ARRAY[6::numeric, 7::numeric]) AS is_weekend,
    COALESCE(ev.event_count, 0::bigint) AS event_count,
    ev.categories,
    COALESCE(ev.has_pro_baseball, false) AS has_pro_baseball,
    COALESCE(ev.has_live, false) AS has_live,
    COALESCE(ev.has_ama_baseball, false) AS has_ama_baseball,
    COALESCE(ev.event_count, 0::bigint) > 0 AS has_event,
    ev.max_expected_attendance,
    w.weather_code,
    w.temp_max,
    w.temp_min,
    w.precipitation_mm,
    w.precip_prob,
    w.summary,
    COALESCE(w.precipitation_mm, 0::numeric) >= 1::numeric AS is_rainy,
    COALESCE(ev.has_sports_broadcast, false) AS has_sports_broadcast,
    COALESCE(ev.has_japan_match, false) AS has_japan_match,
    COALESCE(ev.has_soccer_pv, false) AS has_soccer_pv,
    COALESCE(ev.has_dome_main, false) AS has_dome_main
   FROM ( SELECT foodcourt_daily_facts.business_date FROM foodcourt_daily_facts
        UNION SELECT tokyo_dome_events.event_date FROM tokyo_dome_events
        UNION SELECT weather_daily.weather_date FROM weather_daily WHERE weather_daily.location = 'tokyo_dome'::text) d(business_date)
     LEFT JOIN LATERAL ( SELECT count(*) AS event_count,
            string_agg(DISTINCT e.category, ','::text) AS categories,
            bool_or(e.category = 'プロ野球'::text) AS has_pro_baseball,
            bool_or(e.category = 'ライブ'::text) AS has_live,
            bool_or(e.category = 'アマ野球'::text) AS has_ama_baseball,
            bool_or(e.category = 'スポーツ中継'::text) AS has_sports_broadcast,
            bool_or(e.is_japan = true) AS has_japan_match,
            bool_or(e.pv_sport = 'soccer'::text) AS has_soccer_pv,
            bool_or(e.venue = 'tokyo-dome'::text) AS has_dome_main,
            max(e.expected_attendance) AS max_expected_attendance
           FROM tokyo_dome_events e
          WHERE e.event_date = d.business_date) ev ON true
     LEFT JOIN weather_daily w ON w.weather_date = d.business_date AND w.location = 'tokyo_dome'::text;
