create or replace function public.invoke_receipt_midreport_cron()
returns void
language plpgsql
security definer
set search_path = 'public', 'extensions'
as $$
declare
  v_now_jst timestamp := now() at time zone 'Asia/Tokyo';
begin
  if not exists (
    select 1
    from public.room_summary_settings s
    where s.bot_access_approved = true
      and s.is_enabled = true
      and (
        (
          s.receipt_midreport_enabled = true
          and extract(hour from v_now_jst)::int = coalesce(s.receipt_midreport_hour, 10)
          and extract(minute from v_now_jst)::int = coalesce(s.receipt_midreport_minute, 0)
        )
        or
        (
          s.receipt_monthend_report_enabled = true
          and extract(hour from v_now_jst)::int = coalesce(s.receipt_monthend_hour, 10)
          and extract(minute from v_now_jst)::int = coalesce(s.receipt_monthend_minute, 0)
        )
      )
  ) then
    return;
  end if;

  perform net.http_post(
    url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/receipt-midreport-cron',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || public.resolve_edge_cron_auth_token(),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
end;
$$;

create or replace function public.invoke_reservation_today_cron()
returns void
language plpgsql
security definer
set search_path = 'public', 'extensions'
as $$
declare
  v_now_jst timestamp := now() at time zone 'Asia/Tokyo';
begin
  if not exists (
    select 1
    from public.room_summary_settings s
    where s.today_reservation_alert_enabled = true
      and coalesce(s.is_enabled, true) = true
      and extract(hour from v_now_jst)::int = coalesce(s.today_reservation_alert_hour, 18)
      and extract(minute from v_now_jst)::int = coalesce(s.today_reservation_alert_minute, 0)
  ) then
    return;
  end if;

  perform net.http_post(
    url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/reservation-today-cron',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || public.resolve_edge_cron_auth_token(),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
end;
$$;

create or replace function public.invoke_review_alert_cron()
returns void
language plpgsql
security definer
set search_path = 'public', 'extensions'
as $$
declare
  v_now_jst timestamp := now() at time zone 'Asia/Tokyo';
begin
  if not exists (
    select 1
    from public.room_summary_settings s
    where s.review_alert_enabled = true
      and nullif(btrim(s.room_id), '') is not null
      and nullif(btrim(s.receipt_report_store_partition_key), '') is not null
      and extract(hour from v_now_jst)::int = coalesce(s.review_alert_hour, 8)
      and extract(minute from v_now_jst)::int = coalesce(s.review_alert_minute, 10)
  ) then
    return;
  end if;

  perform net.http_post(
    url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/review-alert-cron',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || public.resolve_edge_cron_auth_token(),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
end;
$$;

create or replace function public.invoke_tokyo_dome_weekly_cron()
returns void
language plpgsql
security definer
set search_path = 'public', 'extensions'
as $$
declare
  v_now_jst timestamp := now() at time zone 'Asia/Tokyo';
begin
  if not exists (
    select 1
    from public.room_summary_settings s
    where s.dome_weekly_enabled = true
      and coalesce(s.is_enabled, true) = true
      and nullif(btrim(s.room_id), '') is not null
      and extract(dow from v_now_jst)::int = coalesce(s.dome_weekly_dow, 6)
      and extract(hour from v_now_jst)::int = coalesce(s.dome_weekly_hour, 10)
      and extract(minute from v_now_jst)::int = coalesce(s.dome_weekly_minute, 0)
  ) then
    return;
  end if;

  perform net.http_post(
    url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/tokyo-dome-weekly-cron',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || public.resolve_edge_cron_auth_token(),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
end;
$$;
