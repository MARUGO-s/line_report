-- pv_japan_alert_logs の二重送信防止キーに pv_confirmed を追加。
--
-- 背景: 営業時間外(深夜/早朝)の未確証PV(決勝T等)は「🌙 放映は要確認」の事前通知を送る。
--   その後 FOOD STADIUM が公式告知して pv_confirmed=true に昇格したら「🇯🇵 PV決定」を
--   もう一度送りたい。旧PK (room_id, event_date, title) だと2通目がブロックされるため、
--   pv_confirmed を主キーに含め「1試合×ルーム×フェーズ(要確認/決定)で各1回」にする。
--
-- 冪等: 列追加は IF NOT EXISTS、PK差し替えは現PKが pv_confirmed を含まない時だけ実施。
alter table public.pv_japan_alert_logs
  add column if not exists pv_confirmed boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.pv_japan_alert_logs'::regclass
      and contype = 'p'
      and pg_get_constraintdef(oid) like '%pv_confirmed%'
  ) then
    alter table public.pv_japan_alert_logs drop constraint if exists pv_japan_alert_logs_pkey;
    alter table public.pv_japan_alert_logs add primary key (room_id, event_date, title, pv_confirmed);
  end if;
end $$;
