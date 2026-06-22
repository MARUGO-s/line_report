-- ============================================================
-- 来客予想（フォーキャスト）機能の土台。
-- 「イベント・天気・曜日・他店の動向」を踏まえた来客/売上予測を、データが溜まったら
-- 実装できるよう、いまのうちにバックヤードへ正規化して蓄積する。
--
--   1) foodcourt_daily_facts          : 日次×全11テナントの実績（JSONを正規化＝学習データ本体）
--   2) tokyo_dome_events.expected_attendance : 予想動員（将来データ用・任意）
--   3) forecast_predictions           : 生成した予測の保存（後で実測と突合＝精度検証）
--   4) foodcourt_daily_features (view): 予測の特徴量（曜日・イベント・天気）を日付単位で1行に
--   5) trigger sync_foodcourt_daily_facts : reports へ書かれたら facts を自動同期（経路非依存）
--
-- セキュリティ（恒久前提）: 新規テーブルは RLS 有効・ポリシー無し（anon/authenticated 不可、
--   service_role のみ=バックエンド専用）。関数は SECURITY DEFINER + search_path=public。
--   ビューは security_invoker=true。
-- ============================================================

-- 1) 日次×テナント 実績ファクト（全11テナント分。自店の予測時に他店を特徴量として使える）
create table if not exists public.foodcourt_daily_facts (
  id               bigint generated always as identity primary key,
  business_date    date not null,
  source_store_key text,                       -- 取込元（=marugoS）。実体の店舗は tenant_*
  tenant_code      text,                        -- 安定POSコード（同定キー）
  tenant_name      text not null,               -- 正規化済みテナント名
  sales            bigint,
  guests           integer,
  avg_spend        integer,                     -- 客単価（sales/guests を丸め）
  comp_sales       bigint,
  comp_guests      integer,
  is_base          boolean not null default false,  -- 自店(MARUGO S)か
  source_report_id bigint,                      -- foodcourt_tenant_reports.id への参照
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint uq_fdf_date_tenant unique (business_date, tenant_name)
);
create index if not exists idx_fdf_date       on public.foodcourt_daily_facts(business_date);
create index if not exists idx_fdf_tenant_date on public.foodcourt_daily_facts(tenant_name, business_date);
create index if not exists idx_fdf_code_date  on public.foodcourt_daily_facts(tenant_code, business_date);
alter table public.foodcourt_daily_facts enable row level security;
grant select, insert, update, delete on public.foodcourt_daily_facts to service_role;

-- 2) 予想動員（公式に出ていれば将来ここへ。来客予測の最強ドライバー）
alter table public.tokyo_dome_events add column if not exists expected_attendance integer;

-- 3) 生成した予測の保存（後で actual を埋めて精度検証＝バックテスト）
create table if not exists public.forecast_predictions (
  id             bigint generated always as identity primary key,
  target_date    date not null,
  tenant_name    text not null,
  tenant_code    text,
  metric         text not null default 'guests',     -- 'guests' | 'sales'
  predicted      numeric,
  predicted_low  numeric,                              -- 予測レンジ下限
  predicted_high numeric,                              -- 予測レンジ上限
  model_version  text,                                 -- 'rule-v1' 等
  features       jsonb,                                -- 予測時の特徴量スナップショット（再現用）
  actual         numeric,                              -- 後日の実測（精度検証用）
  created_at     timestamptz not null default now(),
  constraint uq_fp unique (target_date, tenant_name, metric, model_version)
);
create index if not exists idx_fp_target on public.forecast_predictions(target_date);
alter table public.forecast_predictions enable row level security;
grant select, insert, update, delete on public.forecast_predictions to service_role;

-- 4) 予測の特徴量ビュー（曜日・イベント・天気を日付単位で1行に。過去=学習／未来=予測入力）
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
  (coalesce(w.precipitation_mm, 0) >= 1) as is_rainy
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
         max(e.expected_attendance)       as max_expected_attendance
  from public.tokyo_dome_events e
  where e.event_date = d.business_date
) ev on true
left join public.weather_daily w on w.weather_date = d.business_date and w.location = 'tokyo_dome';

grant select on public.foodcourt_daily_features to service_role;

-- 5) reports → facts 同期トリガー（どの経路で書かれても facts を最新に保つ）
create or replace function public.sync_foodcourt_daily_facts()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  bdate date;
  base  text;
begin
  if tg_op = 'DELETE' then
    delete from public.foodcourt_daily_facts where source_report_id = old.id;
    return old;
  end if;
  bdate := coalesce(new.report_date, (new.created_at at time zone 'Asia/Tokyo')::date);
  base  := coalesce(new.base_tenant_name, 'MARUGO S');
  delete from public.foodcourt_daily_facts where source_report_id = new.id;
  insert into public.foodcourt_daily_facts
    (business_date, source_store_key, tenant_code, tenant_name, sales, guests, avg_spend, comp_sales, comp_guests, is_base, source_report_id)
  select
    bdate,
    new.store_partition_key,
    nullif(t->>'code', ''),
    t->>'name',
    nullif(regexp_replace(coalesce(t->>'sales', ''),  '[^0-9-]', '', 'g'), '')::bigint,
    nullif(regexp_replace(coalesce(t->>'guests', ''), '[^0-9-]', '', 'g'), '')::int,
    case when nullif(regexp_replace(coalesce(t->>'guests', ''), '[^0-9]', '', 'g'), '')::numeric > 0
         then round( nullif(regexp_replace(coalesce(t->>'sales', ''),  '[^0-9-]', '', 'g'), '')::numeric
                   / nullif(regexp_replace(coalesce(t->>'guests', ''), '[^0-9]',  '', 'g'), '')::numeric )
         else null end,
    nullif(regexp_replace(coalesce(t->>'compSales', ''),  '[^0-9-]', '', 'g'), '')::bigint,
    nullif(regexp_replace(coalesce(t->>'compGuests', ''), '[^0-9-]', '', 'g'), '')::int,
    (lower(regexp_replace(coalesce(t->>'name', ''), '\s', '', 'g')) = lower(regexp_replace(base, '\s', '', 'g'))),
    new.id
  from jsonb_array_elements(new.tenants) t
  where coalesce(t->>'name', '') <> ''
  on conflict (business_date, tenant_name) do update set
    source_store_key = excluded.source_store_key,
    tenant_code      = excluded.tenant_code,
    sales            = excluded.sales,
    guests           = excluded.guests,
    avg_spend        = excluded.avg_spend,
    comp_sales       = excluded.comp_sales,
    comp_guests      = excluded.comp_guests,
    is_base          = excluded.is_base,
    source_report_id = excluded.source_report_id,
    updated_at       = now();
  return new;
end $fn$;

-- トリガー関数は SECURITY DEFINER。RPC として anon/authenticated から叩けないよう EXECUTE を剥奪
-- （トリガー実行には EXECUTE 権限は不要なので同期は止まらない）。Advisor 警告の解消も兼ねる。
revoke all on function public.sync_foodcourt_daily_facts() from public, anon, authenticated;

drop trigger if exists trg_sync_foodcourt_daily_facts on public.foodcourt_tenant_reports;
create trigger trg_sync_foodcourt_daily_facts
after insert or update or delete on public.foodcourt_tenant_reports
for each row execute function public.sync_foodcourt_daily_facts();

-- 6) 既存データのバックフィル（no-op update でトリガーを発火させ facts を生成）
update public.foodcourt_tenant_reports set base_tenant_name = base_tenant_name;
