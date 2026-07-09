-- 東京ドームの野球イベントにスコアと点差（得点差の絶対値）を追加。
-- これらは接戦度合い（盛り上がり）や一方的な試合展開が売上に与える影響の分析に使われる。

alter table public.tokyo_dome_events
  add column if not exists game_score text,
  add column if not exists score_margin integer;

comment on column public.tokyo_dome_events.game_score is '試合スコア（例: 3 - 1, 6 - 12）';
comment on column public.tokyo_dome_events.score_margin is '得点差の絶対値（例: 2, 6）';
