-- tokyo_dome_events に「フードコート公式PV告知済みか」のフラグ pv_confirmed を追加。
--
-- 背景: PV(public-viewing)の日本戦は単独LINE配信(pv-japan-alert-cron)するが、
--   source='manual-seed:worldcup2026' の中に「FOOD STADIUM が公式に日付付き告知済み(グループ戦)」と
--   「対戦相手・日付が未確定の憶測(決勝T)」が混在していた。前者だけ「PV放映が決定」と断定し、
--   後者は断定しない（が、営業時間外=深夜/早朝の試合は深夜営業判断のため事前に要確認通知は送る）ため、
--   確証の有無をデータで明示できるようにする。
--
-- 冪等。GitHub統合での自動適用と、MCPでの先行適用の二重実行に耐えるよう IF NOT EXISTS / 条件付きUPDATE。

alter table public.tokyo_dome_events
  add column if not exists pv_confirmed boolean not null default false;

comment on column public.tokyo_dome_events.pv_confirmed is
  'フードコート(FOOD STADIUM TOKYO)の公式PV放映告知が確認できたPVだけ true。false=未確証(憶測の決勝T等)。pv-japan-alert-cron の単独配信の文面分岐に使用。';

-- FOOD STADIUM TOKYO が公式に日付付きで告知したグループステージ3戦のみ確証ありに backfill
-- (公式: 6/15オランダ5:00 / 6/21チュニジア13:00 / 6/26スウェーデン8:00)。決勝T(6/30等)は未確証=false のまま。
update public.tokyo_dome_events
   set pv_confirmed = true
 where venue = 'public-viewing' and is_japan = true and pv_sport = 'soccer'
   and event_date in ('2026-06-15', '2026-06-21', '2026-06-26');
