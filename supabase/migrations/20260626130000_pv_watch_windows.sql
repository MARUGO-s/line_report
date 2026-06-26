-- ============================================================
-- PV(日本戦)検索の「監視ウィンドウ」カレンダー。
-- W杯/WBC/五輪/アジアカップ等の大会は日程が年単位で既知なので、ここに各大会の監視期間を登録し、
-- 定期Web検索ルーティンは「ウィンドウ内だけ毎日・深く」探す（ウィンドウ外は深掘りしない）。
-- ボクシング(日本人世界戦)は不定期なのでルーティンが毎回軽く検索する（ウィンドウ管理外）。
-- ルーティンは今日がどのウィンドウ内かで自分の実行頻度を自己調整する（内=毎日/外=週1）。
-- セキュリティ: RLS有効・service_roleのみ。
-- ============================================================

create table if not exists public.pv_watch_windows (
  label        text primary key,
  sport        text,
  monitor_from date not null,   -- この日から毎日・深く探す（大会開始の約3週間前を目安）
  end_date     date not null,   -- 大会終了日（この日まで毎日）
  note         text,
  updated_at   timestamptz not null default now()
);
alter table public.pv_watch_windows enable row level security;
grant select, insert, update, delete on public.pv_watch_windows to service_role;

-- 既知の大会を初期登録（ルーティンが今後の大会を随時追記・更新する）
insert into public.pv_watch_windows (label, sport, monitor_from, end_date, note) values
  ('FIFAワールドカップ2026', 'soccer',  '2026-06-01', '2026-07-19', '米加墨開催。日本は決勝T進出。開催中＝毎日深掘り'),
  ('AFCアジアカップ2027',   'soccer',  '2026-12-17', '2027-02-05', 'サウジ開催 1/7-2/5。日本代表参加'),
  ('ロサンゼルス五輪2028',  'olympic', '2028-06-23', '2028-07-30', 'LA28 本大会 7/14-7/30')
on conflict (label) do update set
  sport=excluded.sport, monitor_from=excluded.monitor_from, end_date=excluded.end_date, note=excluded.note, updated_at=now();
