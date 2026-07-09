-- 巨人戦の全試合結果・動員数を独立して蓄積する専用のテーブルを作成する。
-- これにより、東京ドーム以外の地方球場の試合（長野・前橋等）も考慮したプロ野球特化の分析が可能になる。

create table if not exists public.giants_game_results (
  game_date date primary key,
  opponent text not null,
  venue text not null,
  attendance integer,
  game_result text,
  game_score text,
  score_margin integer,
  game_duration text,
  start_time text,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

comment on table public.giants_game_results is '読売ジャイアンツの全試合日程・結果・動員数データ';
comment on column public.giants_game_results.game_date is '試合日';
comment on column public.giants_game_results.opponent is '対戦相手（例: 阪神, 中日）';
comment on column public.giants_game_results.venue is '開催球場（例: 東京ドーム, バンテリンドーム）';
comment on column public.giants_game_results.attendance is '観客動員数';
comment on column public.giants_game_results.game_result is '試合結果（○, ●, △）';
comment on column public.giants_game_results.game_score is 'スコア（例: 3 - 1）';
comment on column public.giants_game_results.score_margin is '得点差の絶対値';
comment on column public.giants_game_results.game_duration is '試合時間（例: 2:23）';
comment on column public.giants_game_results.start_time is '試合開始時間（例: 18:15）';

-- RLS (Row Level Security) の有効化
alter table public.giants_game_results enable row level security;

-- バックエンドや管理者向けの読み書きポリシー
create policy "Allow public read" on public.giants_game_results for select using (true);
create policy "Allow system write" on public.giants_game_results for all using (true) with check (true);
