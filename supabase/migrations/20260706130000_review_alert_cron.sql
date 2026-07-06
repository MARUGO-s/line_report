-- 自店舗・登録済み競合店に「新しい口コミ」が付いたら、そのルーム宛にLINE通知する仕組み。
-- 通知の要否はルームごとのトグル（review_alert_enabled、既定OFF＝許可した部屋だけ）で制御する。
-- 新着判定は Google Places の user_ratings_total（累計口コミ数）の増分で行う。
-- 初回チェック時は既存の口コミ数をベースラインとして記録するだけ（過去分をまとめて通知しない）。
-- 1日1回、review-alert-cron が対象店舗・競合店を巡回して Google Places を再取得→差分検知→通知する。

-- 1) ルームごとの通知トグル（既定OFF）
alter table public.room_summary_settings
  add column if not exists review_alert_enabled boolean not null default false;

comment on column public.room_summary_settings.review_alert_enabled
  is 'ONの部屋だけ、自店舗・登録済み競合の新着口コミをLINEに通知する（既定OFF）。';

-- 2) 新着検知のベースライン（直近に通知した時点の累計口コミ数）
alter table public.store_review_places
  add column if not exists last_alerted_rating_total integer;
alter table public.competitor_places
  add column if not exists last_alerted_rating_total integer;

comment on column public.store_review_places.last_alerted_rating_total
  is '直近にLINE通知した時点のuser_ratings_total（累計口コミ数）。NULL=未チェック（初回はベースライン記録のみで通知しない）。';
comment on column public.competitor_places.last_alerted_rating_total
  is '直近にLINE通知した時点のuser_ratings_total（累計口コミ数）。NULL=未チェック（初回はベースライン記録のみで通知しない）。';

-- 3) 1日1回起動 cron（JST 08:10 = UTC 23:10 前日）
create or replace function public.invoke_review_alert_cron()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  edge_function_url text;
  cron_auth_token text;
  request_id bigint;
begin
  edge_function_url := nullif(current_setting('custom.review_alert_edge_function_url', true), '');
  if edge_function_url is null then
    edge_function_url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/review-alert-cron';
  end if;

  cron_auth_token := public.resolve_edge_cron_auth_token();
  if cron_auth_token is null then
    raise warning 'invoke_review_alert_cron skipped: cron auth token is not configured';
    return;
  end if;

  select net.http_post(
    url := edge_function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || cron_auth_token
    ),
    body := '{}'::jsonb
  ) into request_id;

  raise log 'invoke_review_alert_cron: Triggered Edge Function at %, request_id=%', edge_function_url, request_id;
end;
$$;
revoke all on function public.invoke_review_alert_cron() from public, anon, authenticated;

do $$
begin
  begin
    perform cron.unschedule('review-alert-cron-job');
  exception when others then null;
  end;
end
$$;

select cron.schedule(
  'review-alert-cron-job',
  '10 23 * * *',
  $$ select public.invoke_review_alert_cron(); $$
);
