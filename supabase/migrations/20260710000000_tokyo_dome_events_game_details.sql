-- 東京ドームの野球イベントに試合詳細（開始時間、試合時間、勝敗結果）を追加するカラムの追加。
-- これらは売上・客数への時間軸・勝敗別の影響分析に利用される。

alter table public.tokyo_dome_events
  add column if not exists start_time text,
  add column if not exists game_duration text,
  add column if not exists game_result text;

comment on column public.tokyo_dome_events.start_time is '試合開始時間（例: 18:15, 14:00）';
comment on column public.tokyo_dome_events.game_duration is '試合時間（例: 2:45, 3:15）';
comment on column public.tokyo_dome_events.game_result is '試合結果（○:勝ち, ●:負け, △:引き分け）';
