-- 予測特徴量ビューに会場フラグ has_kanadevia / has_korakuen を追加する。
--
-- 背景（#5 会場×客層別の係数）: これまで東京ドーム本体が無い「小ホールのみの日」は forecast-cron 側で
--   一律 "hall" 係数にまとめていた。しかし会場で客層と来館動機が異なる:
--     - 後楽園ホール(korakuen)  = 格闘技/ボクシング中心 → 中年男性層
--     - カナデビアホール(kanadevia) = ライブ中心 → 若年層
--   フードコートの飲食利用パターンが変わるため、会場別に係数を学習できるよう会場フラグを公開する。
--   forecast-cron 側は has_korakuen → hall_korakuen / has_kanadevia → hall_kanadevia /
--   それ以外の小ホール → hall_other に振り分ける（venue-segment-v1）。
-- 冪等: CREATE OR REPLACE（既存列は同順で保持し、末尾に has_kanadevia / has_korakuen を追加）。
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
    COALESCE(ev.has_dome_main, false) AS has_dome_main,
    COALESCE(ev.has_kanadevia, false) AS has_kanadevia,
    COALESCE(ev.has_korakuen, false) AS has_korakuen
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
            bool_or(e.venue = 'kanadevia'::text) AS has_kanadevia,
            bool_or(e.venue = 'korakuen'::text) AS has_korakuen,
            max(e.expected_attendance) AS max_expected_attendance
           FROM tokyo_dome_events e
          WHERE e.event_date = d.business_date) ev ON true
     LEFT JOIN weather_daily w ON w.weather_date = d.business_date AND w.location = 'tokyo_dome'::text;

comment on view public.foodcourt_daily_features is
  'foodcourt-forecast-cron 用の日次特徴量ビュー。会場フラグ has_dome_main/has_kanadevia/has_korakuen で会場×客層別の係数学習に対応(venue-segment-v1)。';
