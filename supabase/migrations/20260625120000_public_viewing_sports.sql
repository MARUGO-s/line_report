-- ============================================================
-- パブリックビューイング（PV）＝世界的スポーツ放映を客数分析に取り込む土台。
-- 東京ドーム内フードコート(マルゴS)の大型モニターで、W杯/WBC/世界ボクシング/五輪 等の
-- 日本人・日本代表の試合を放映する日は集客が大きく、日本戦のときは深夜営業になることもある
-- （＝集客の大ドライバー）。実測でも 2026-06-21 日本×チュニジア(13:00 JST放映)は 244人/¥388,601 と
-- 前後の平日(45〜86人)に対し突出。一方 06-15 オランダ戦(5:00 JST)は 47人＝早朝試合は日中客数に出にくい。
--
-- 設計: 既存 tokyo_dome_events に venue='public-viewing' / category='スポーツ中継' として相乗りさせ、
--       既存の特徴量ビュー → 予測cron → 画面(foodcourt.html) → 週次LINE通知 の全経路へ自動連動させる
--       （新テーブルを作らず単一ソースに寄せる）。データは定期Web検索ルーティンが維持する。
--
-- 追加:
--   - tokyo_dome_events.is_japan : 日本人/日本代表が出る（=深夜営業の要注意フラグ／予測の最強種別）
--   - tokyo_dome_events.note     : 放映時刻・「深夜〜早朝営業」等の運用メモ
--   - foodcourt_daily_features に has_sports_broadcast / has_japan_match を追加
-- セキュリティ: 既存方針踏襲（テーブルRLS有効・service_roleのみ／ビューは security_invoker=true）。
-- 冪等: add column if not exists ／ create or replace view。
-- ============================================================

alter table public.tokyo_dome_events add column if not exists is_japan boolean not null default false;
alter table public.tokyo_dome_events add column if not exists note text;

-- 特徴量ビューを再作成（スポーツ放映フラグ・日本戦フラグを追加）
create or replace view public.foodcourt_daily_features
with (security_invoker = true) as
select
  d.business_date,
  extract(isodow from d.business_date)::int as iso_dow,            -- 1=月..7=日
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
  -- ↓ create or replace view の制約上、新規列は末尾に追加する
  coalesce(ev.has_sports_broadcast, false) as has_sports_broadcast,  -- PV: スポーツ中継があるか
  coalesce(ev.has_japan_match, false)      as has_japan_match         -- PV: 日本人/日本代表の試合があるか（深夜営業の主因）
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
         max(e.expected_attendance)       as max_expected_attendance
  from public.tokyo_dome_events e
  where e.event_date = d.business_date
) ev on true
left join public.weather_daily w on w.weather_date = d.business_date and w.location = 'tokyo_dome';

grant select on public.foodcourt_daily_features to service_role;
