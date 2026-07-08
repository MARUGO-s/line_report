-- フードコート週次経営レポートの自動生成・配信機能。
-- ルームごとに有効/無効と配信曜日・時刻を設定できる（room_summary_settingsのトグルで制御）。
-- 毎時cronが全ルームを巡回し、現在JST時刻が設定と一致するルームのみレポートを生成してLINEに送る。

-- 1) room_summary_settings: 週次レポートの曜日・時刻カラムを追加
alter table public.room_summary_settings
  add column if not exists foodcourt_weekly_report_enabled boolean not null default false,
  add column if not exists foodcourt_weekly_dow    smallint,
  add column if not exists foodcourt_weekly_hour   smallint,
  add column if not exists foodcourt_weekly_minute smallint;

comment on column public.room_summary_settings.foodcourt_weekly_report_enabled
  is 'ONのルームだけ、毎週設定の曜日・時刻にフードコート週次経営レポートをLINEで配信する（既定OFF）。';
comment on column public.room_summary_settings.foodcourt_weekly_dow
  is '週次レポートを送る曜日（0=日〜6=土）。NULLは月曜（1）として扱う。';
comment on column public.room_summary_settings.foodcourt_weekly_hour
  is '週次レポートを送るJST時刻（時）。NULLは9として扱う。';
comment on column public.room_summary_settings.foodcourt_weekly_minute
  is '週次レポートを送るJST時刻（分）。NULLは0として扱う。';

-- 2) foodcourt_weekly_reports: 生成したレポートをキャッシュ
create table if not exists public.foodcourt_weekly_reports (
  id                  uuid primary key default gen_random_uuid(),
  store_partition_key text not null,
  week_start          date not null,
  week_end            date not null,
  ai_report           text,
  raw_data            jsonb,
  loop_score          integer,
  loop_count          integer,
  created_at          timestamptz not null default now()
);

comment on table public.foodcourt_weekly_reports
  is 'フードコート週次経営レポート。AIが生成した先週の売上分析・施策効果・経営アドバイスを保存する。';

create index if not exists foodcourt_weekly_reports_store_week_idx
  on public.foodcourt_weekly_reports (store_partition_key, week_start desc);

alter table public.foodcourt_weekly_reports enable row level security;
create policy "service_role_all" on public.foodcourt_weekly_reports
  using (true) with check (true);
