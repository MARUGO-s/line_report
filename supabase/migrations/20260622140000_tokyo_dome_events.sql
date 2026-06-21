-- 東京ドームのイベント予定（野球/ライブ等）。マルゴS（東京ドーム内）の客数・売上との相関分析に使う。
-- 自動取得cron（tokyo-dome-events-cron）が公式サイトから取得して upsert する。分析専用。
create table if not exists public.tokyo_dome_events (
  event_date date not null,
  title text not null,
  category text,                       -- プロ野球 / アマ野球 / ライブ / その他
  source text not null default 'tokyo-dome.co.jp',
  updated_at timestamptz not null default now(),
  primary key (event_date, title)
);

create index if not exists tokyo_dome_events_date_idx on public.tokyo_dome_events (event_date);

comment on table public.tokyo_dome_events is
  '東京ドームのイベント予定（自動取得・分析専用）。マルゴS客数/売上との相関に使う。';

alter table public.tokyo_dome_events enable row level security;

-- 2026年6月分の初期データ（公式サイト tokyo-dome.co.jp より。cron稼働後は自動更新）。
insert into public.tokyo_dome_events (event_date, title, category) values
('2026-06-02','巨人ーオリックス','プロ野球'),
('2026-06-03','巨人ーオリックス','プロ野球'),
('2026-06-04','巨人ーオリックス','プロ野球'),
('2026-06-05','巨人ーロッテ','プロ野球'),
('2026-06-06','巨人ーロッテ','プロ野球'),
('2026-06-07','巨人ーロッテ','プロ野球'),
('2026-06-08','第75回全日本大学野球選手権記念大会','アマ野球'),
('2026-06-09','第75回全日本大学野球選手権記念大会','アマ野球'),
('2026-06-10','第75回全日本大学野球選手権記念大会','アマ野球'),
('2026-06-13','NiziU Live with U 2026 "NiziU : THE CINEMA"','ライブ'),
('2026-06-14','NiziU Live with U 2026 "NiziU : THE CINEMA"','ライブ'),
('2026-06-19','巨人ー中日','プロ野球'),
('2026-06-20','巨人ー中日','プロ野球'),
('2026-06-21','巨人ー中日','プロ野球'),
('2026-06-22','楽天ー西武','プロ野球'),
('2026-06-24','IVE WORLD TOUR ''SHOW WHAT I AM'' IN JAPAN','ライブ'),
('2026-06-27','三代目 J SOUL BROTHERS PRESENTS "JSB LAND 〜FOREVER〜"','ライブ'),
('2026-06-28','三代目 J SOUL BROTHERS PRESENTS "JSB LAND 〜FOREVER〜"','ライブ'),
('2026-06-30','ソフトバンクー西武','プロ野球')
on conflict (event_date, title) do nothing;
