-- 「AI分析」Bot への質問に、必ず何かしら返事が届くようにする。
--
-- mtalk-external-post /chat-dispatch は質問ごとに chat_alert_dispatches（kind = 'ai_chat_reply'）を1行確保し、
-- 答え・失敗の案内を送る前に status を pending → answered / failed へ1回だけ確定する。
-- 関数が止まった・gourmet の返事が遅い・途中で落ちたなどで、2分たっても答えが出ていない質問には、
-- 見張り chat_ai_analysis_reply_timeouts()（high-frequency-dispatcher-cron から毎分）が status を timed_out に確定し、
-- Bot として案内を1通送る。status の確定は pending のときだけ成功するため、案内と遅れて届いた答えは重ならない
-- （関数側は確定に失敗したら答えを捨てる）。
-- 確定したのに1通目が記録されていない（送る直前に関数が止まった）ものも2分後に案内する。
--
-- 画面の「・・・」（public/chat/messages.js）も120秒で同じ文の案内（端末だけの表示）に切り替わる。

alter table public.chat_alert_dispatches
  add column if not exists status text,
  add column if not exists finished_at timestamptz;

alter table public.chat_alert_dispatches
  drop constraint if exists chat_alert_dispatches_status_check;
alter table public.chat_alert_dispatches
  add constraint chat_alert_dispatches_status_check
  check (status is null or status in ('pending', 'answered', 'failed', 'timed_out'));

-- この仕組みより前の行は見張りの対象にしない（返事の記録がないものも閉じた扱い）。
update public.chat_alert_dispatches
   set status = case when message_id is null then 'timed_out' else 'answered' end,
       finished_at = coalesce(finished_at, created_at)
 where kind = 'ai_chat_reply'
   and status is null;

create index if not exists idx_chat_alert_dispatches_ai_reply_open
  on public.chat_alert_dispatches (created_at)
  where kind = 'ai_chat_reply' and message_id is null;

comment on column public.chat_alert_dispatches.status is
  'kind = ai_chat_reply のときだけ使う: pending → answered / failed（mtalk-external-post）または timed_out（chat_ai_analysis_reply_timeouts）。pending からの確定は1回だけ。';

create or replace function public.chat_ai_analysis_reply_timeouts()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_bot constant uuid := '00000000-0000-4000-8000-00000000b073';
  v_text constant text := 'すみません、返事に時間がかかっています。エラーが起きた可能性があるので、もう一度送ってください。';
  r record;
  v_msg_id bigint;
  v_count integer := 0;
begin
  -- 1行ずつ「timed_out への確定＋案内の投稿」をまとめて行う。投稿に失敗したら確定も戻り、次の回にやり直す。
  -- for update skip locked で行を押さえるため、同じ時に関数側が確定しようとしても待たされ、
  -- 見張りが確定したあとは pending でなくなるので、関数側は答えを捨てる。
  for r in
    select d.id, d.chat_group_id
      from public.chat_alert_dispatches d
     where d.kind = 'ai_chat_reply'
       and d.message_id is null
       and d.created_at > now() - interval '1 day'
       and (
         (d.status = 'pending' and d.created_at < now() - interval '2 minutes')
         or (d.status in ('answered', 'failed') and d.finished_at < now() - interval '2 minutes')
       )
     order by d.id
     limit 50
     for update skip locked
  loop
    begin
      update public.chat_alert_dispatches
         set status = 'timed_out', finished_at = now()
       where id = r.id;
      insert into public.chat_messages (group_id, user_id, username, content, kind)
      values (r.chat_group_id, v_bot, 'AI分析', v_text, 'text')
      returning id into v_msg_id;
      update public.chat_alert_dispatches set message_id = v_msg_id where id = r.id;
      v_count := v_count + 1;
    exception when others then
      raise warning 'chat_ai_analysis_reply_timeouts: dispatch % failed: %', r.id, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$fn$;

revoke all on function public.chat_ai_analysis_reply_timeouts() from public, anon, authenticated;
grant execute on function public.chat_ai_analysis_reply_timeouts() to postgres, service_role;

-- 毎分の見張りは既存の high-frequency-dispatcher-cron-job にまとめる（単独ジョブは増やさない）。
-- 以下は本番の定義（20260826010000）に見張りの呼び出しを先頭へ足したもの。
create or replace function public.invoke_high_frequency_dispatcher_cron()
returns void
language plpgsql
security definer
set search_path = 'public', 'extensions', 'cron'
as $$
declare
  v_minute int := extract(minute from (now() at time zone 'Asia/Tokyo'))::int;
begin
  -- 「AI分析」Bot への質問の見張り（2分たっても答えていなければ案内を送る。毎分）
  begin
    perform public.chat_ai_analysis_reply_timeouts();
  exception when others then
    raise warning 'high-frequency dispatcher: ai-analysis-reply-timeouts failed: %', sqlerrm;
  end;

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

revoke all on function public.invoke_high_frequency_dispatcher_cron() from public, anon, authenticated;
grant execute on function public.invoke_high_frequency_dispatcher_cron() to postgres, service_role;
