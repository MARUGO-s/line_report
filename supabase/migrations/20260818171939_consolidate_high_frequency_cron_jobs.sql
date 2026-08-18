create or replace function public.invoke_high_frequency_dispatcher_cron()
returns void
language plpgsql
security definer
set search_path = 'public', 'extensions', 'cron'
as $$
declare
  v_minute int := extract(minute from (now() at time zone 'Asia/Tokyo'))::int;
begin
  begin
    perform public.invoke_gmail_alert_cron();
  exception when others then
    raise warning 'high-frequency dispatcher: gmail failed: %', sqlerrm;
  end;

  begin
    perform public.invoke_receipt_midreport_cron();
  exception when others then
    raise warning 'high-frequency dispatcher: receipt-midreport failed: %', sqlerrm;
  end;

  begin
    perform public.invoke_reservation_today_cron();
  exception when others then
    raise warning 'high-frequency dispatcher: reservation-today failed: %', sqlerrm;
  end;

  begin
    perform public.invoke_review_alert_cron();
  exception when others then
    raise warning 'high-frequency dispatcher: review-alert failed: %', sqlerrm;
  end;

  begin
    perform public.invoke_tokyo_dome_weekly_cron();
  exception when others then
    raise warning 'high-frequency dispatcher: tokyo-dome-weekly failed: %', sqlerrm;
  end;

  if mod(v_minute, 5) = 0 then
    begin
      perform public.invoke_foodcourt_weekly_report_cron();
    exception when others then
      raise warning 'high-frequency dispatcher: foodcourt-weekly failed: %', sqlerrm;
    end;
  end if;

  if mod(v_minute, 10) = 0 then
    begin
      perform public.invoke_pv_japan_alert_cron();
    exception when others then
      raise warning 'high-frequency dispatcher: pv-japan failed: %', sqlerrm;
    end;
  end if;
end;
$$;

do $$
begin
  if exists (select 1 from cron.job where jobname='gmail-alert-cron-job') then perform cron.unschedule('gmail-alert-cron-job'); end if;
  if exists (select 1 from cron.job where jobname='receipt-midreport-cron-job') then perform cron.unschedule('receipt-midreport-cron-job'); end if;
  if exists (select 1 from cron.job where jobname='reservation-today-cron-job') then perform cron.unschedule('reservation-today-cron-job'); end if;
  if exists (select 1 from cron.job where jobname='review-alert-cron-job') then perform cron.unschedule('review-alert-cron-job'); end if;
  if exists (select 1 from cron.job where jobname='tokyo-dome-weekly-cron-job') then perform cron.unschedule('tokyo-dome-weekly-cron-job'); end if;
  if exists (select 1 from cron.job where jobname='foodcourt-weekly-report-cron') then perform cron.unschedule('foodcourt-weekly-report-cron'); end if;
  if exists (select 1 from cron.job where jobname='pv-japan-alert-cron-job') then perform cron.unschedule('pv-japan-alert-cron-job'); end if;
  if exists (select 1 from cron.job where jobname='high-frequency-dispatcher-cron-job') then perform cron.unschedule('high-frequency-dispatcher-cron-job'); end if;
  perform cron.schedule('high-frequency-dispatcher-cron-job', '* * * * *', 'select public.invoke_high_frequency_dispatcher_cron();');
end $$;
