-- 過去の巨人戦の試合詳細（観客数、時間、勝敗、スコア、点差）を giants_game_results から tokyo_dome_events テーブルへコピーする。
-- これにより、管理画面の「東京ドームイベント一覧」に観客動員数が即時反映される。

update public.tokyo_dome_events t
set
  expected_attendance = g.attendance,
  start_time = g.start_time,
  game_duration = g.game_duration,
  game_result = g.game_result,
  game_score = g.game_score,
  score_margin = g.score_margin,
  updated_at = now()
from public.giants_game_results g
where t.event_date = g.game_date
  and t.venue = 'tokyo-dome'
  and t.category = 'プロ野球';
