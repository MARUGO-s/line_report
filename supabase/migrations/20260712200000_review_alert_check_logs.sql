-- 口コミ新着通知(review-alert-cron)の自店舗・競合チェックが実際に成功/失敗したかを記録する。
-- これまでは失敗時に例外がその日のHTTPレスポンスにしか残らず、誰も見なければ気づけなかった
-- （実際にマルゴエスだけ週の大半でGoogle Places再取得が失敗し続けていた事例で発覚）。
create table if not exists public.review_alert_check_logs (
  id                  bigint generated always as identity primary key,
  store_partition_key text not null,
  check_kind          text not null, -- 'self' | 'competitor'
  target_name         text,
  place_id            text,
  ok                  boolean not null,
  error               text,
  created_at          timestamptz not null default now()
);

comment on table public.review_alert_check_logs
  is '口コミ新着通知cronの自店舗/競合チェック結果ログ（成功・失敗とも記録し、障害の見える化に使う）。';

create index if not exists idx_review_alert_check_logs_store_created
  on public.review_alert_check_logs(store_partition_key, created_at desc);

alter table public.review_alert_check_logs enable row level security;
grant select, insert, update, delete on public.review_alert_check_logs to service_role;
