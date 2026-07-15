-- 予約メール通知(gmail-alert-cron)を「1分ごと(リアルタイム)」か「N分おきにまとめて配信」か
-- ルームごとに選べるようにする。グループ宛Pushは参加人数分課金されるため、通知が細切れに
-- 届くと送信回数（＝コスト）が増える。間隔を空けるほど、その間に届いた複数件が1通にまとまる。
--
--   gmail_alert_interval_minutes : NULL または 1 = 従来通り毎分チェック（リアルタイム）。
--                                  2以上なら、そのルームは最後の送信からその分数が経つまで
--                                  スキップされ、次に対象になった時点でそれまでの新着をまとめて送る。
--   gmail_alert_last_sent_at     : このルームへ最後に実際に送信できた時刻（間隔判定の起点、内部用）。
alter table public.room_summary_settings
  add column if not exists gmail_alert_interval_minutes integer,
  add column if not exists gmail_alert_last_sent_at timestamptz;
