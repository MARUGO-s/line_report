-- M-talk の予約配信を high-frequency-dispatcher-cron に統合し、毎分確実に実行されるようにする。

-- 1. chat_dispatch_scheduled_messages に postgres ロールの実行権限を付与
grant execute on function public.chat_dispatch_scheduled_messages() to service_role, postgres;

-- 2. high-frequency-dispatcher-cron に chat_dispatch_scheduled_messages を追加
create or replace function public.invoke_high_frequency_dispatcher_cron()
returns void
language plpgsql
security definer
set search_path = 'public', 'extensions', 'cron'
as $$
declare
  v_minute int := extract(minute from (now() at time zone 'Asia/Tokyo'))::int;
begin
  -- M-talk 予約配信のディスパッチ（毎分）
  begin
    perform public.chat_dispatch_scheduled_messages();
  exception when others then
    raise warning 'high-frequency dispatcher: chat-dispatch failed: %', sqlerrm;
  end;

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

-- 3. 単独ジョブの整理（high-frequency-dispatcher-cron-job に集約）
do $$
begin
  if exists (select 1 from cron.job where jobname='chat-scheduled-messages-job') then
    perform cron.unschedule('chat-scheduled-messages-job');
  end if;
exception
  when others then null;
end $$;
