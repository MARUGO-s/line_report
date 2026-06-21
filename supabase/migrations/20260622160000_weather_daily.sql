-- 東京ドーム周辺の日次天気（Open-Meteo より自動取得・分析専用）。
-- マルゴS（東京ドーム内フードコート）の客数・売上との相関分析に使う。weather-daily-cron が upsert する。
create table if not exists public.weather_daily (
  weather_date date not null,
  location text not null default 'tokyo_dome',
  weather_code integer,                 -- WMO weather code
  temp_max numeric,                     -- 最高気温 ℃
  temp_min numeric,                     -- 最低気温 ℃
  precipitation_mm numeric,             -- 降水量 mm
  precip_prob integer,                  -- 降水確率 %（予報のみ）
  summary text,                         -- 日本語ラベル（晴れ/曇り/雨 等）
  source text not null default 'open-meteo',
  updated_at timestamptz not null default now(),
  primary key (weather_date, location)
);

create index if not exists weather_daily_date_idx on public.weather_daily (weather_date);

comment on table public.weather_daily is
  '東京ドーム周辺の日次天気（自動取得・分析専用）。マルゴS客数/売上との相関に使う。';

alter table public.weather_daily enable row level security;
