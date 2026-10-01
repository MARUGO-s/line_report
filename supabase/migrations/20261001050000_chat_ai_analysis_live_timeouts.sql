-- 「AI分析」Bot の「最新を調べる」（gourmet が各サイトにログインして取り直してから答える）の見張り。
--
-- 利用者がデータの質問をすると、gourmet が「1) サイトにログインして最新を調べる / 2) 今あるデータですぐ答える」を返し、
-- mtalk-external-post がカードのボタン（押すとその文が利用者の発言になる）で表示する。「1」を選ぶと gourmet が取得を依頼し、
-- mtalk-external-post は chat_alert_dispatches（kind = 'ai_chat_live'、dedupe_key = 'live:<gourmet の lookup_id>'、status = 'pending'）を
-- 作ってから「調べています。終わったらお知らせします」を送る（この返事で 2分の見張り ai_chat_reply は answered になる）。
-- 取得後に gourmet が POST /chat-reply で答えを送るときは、status を pending → answered に1回だけ確定してから送る。
--
-- 見張り chat_ai_analysis_live_timeouts()（high-frequency-dispatcher-cron から毎分）:
--   ・pending のまま20分たったもの → timed_out に確定し、「2」のボタンつきの案内を Bot として1通送る（以後に届いた答えは 409 で送らない）
--   ・answered なのに1通目が記録されていない（送る直前に関数が止まった）まま2分たったもの → 同じく案内する
-- 「2」で答えた・新しい質問で置き換えたものは mtalk-external-post が failed にする（見張りの対象外）。

comment on column public.chat_alert_dispatches.status is
  'kind = ai_chat_reply / ai_chat_live のときだけ使う: pending → answered / failed（mtalk-external-post）または timed_out（chat_ai_analysis_reply_timeouts / chat_ai_analysis_live_timeouts）。pending からの確定は1回だけ。';

create index if not exists idx_chat_alert_dispatches_ai_live_open
  on public.chat_alert_dispatches (created_at)
  where kind = 'ai_chat_live' and message_id is null;

create or replace function public.chat_ai_analysis_live_timeouts()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_bot constant uuid := '00000000-0000-4000-8000-00000000b073';
  v_text constant text := '最新データの取得が20分以内に終わりませんでした（サイト側の不調や、再ログインが必要な可能性があります）。今あるデータですぐ答える場合は「2」を送ってください。';
  v_payload constant jsonb := jsonb_build_object(
    'v', 1,
    'kind', 'ai_chat_live',
    'cards', jsonb_build_array(jsonb_build_object(
      'header', jsonb_build_object('eyebrow', 'AI分析', 'title', '最新データを取得できませんでした', 'subtitle', null),
      'sections', jsonb_build_array(
        jsonb_build_object('type', 'note', 'text', '最新データの取得が20分以内に終わりませんでした（サイト側の不調や、再ログインが必要な可能性があります）。', 'size', 'sm'),
        jsonb_build_object('type', 'note', 'text', '今あるデータですぐ答える場合は、下のボタンを押すか「2」を送ってください。', 'size', 'sm')
      ),
      'actions', jsonb_build_array(jsonb_build_object('label', '2 今あるデータですぐ答える', 'command', '2：今あるデータですぐ答える', 'style', 'primary'))
    ))
  );
  r record;
  v_msg_id bigint;
  v_count integer := 0;
begin
  -- 1行ずつ「timed_out への確定＋案内の投稿」をまとめて行う。投稿に失敗したら確定も戻り、次の回にやり直す。
  -- for update skip locked で押さえるため、同じ時に /chat-reply が確定しようとしても待たされ、見張りが確定したあとは答えを捨てる（409）。
  for r in
    select d.id, d.chat_group_id
      from public.chat_alert_dispatches d
     where d.kind = 'ai_chat_live'
       and d.message_id is null
       and d.created_at > now() - interval '1 day'
       and (
         (d.status = 'pending' and d.created_at < now() - interval '20 minutes')
         or (d.status = 'answered' and d.finished_at < now() - interval '2 minutes')
       )
     order by d.id
     limit 50
     for update skip locked
  loop
    begin
      update public.chat_alert_dispatches
         set status = 'timed_out', finished_at = now()
       where id = r.id;
      insert into public.chat_messages (group_id, user_id, username, content, kind, payload)
      values (r.chat_group_id, v_bot, 'AI分析', v_text, 'card', v_payload)
      returning id into v_msg_id;
      update public.chat_alert_dispatches set message_id = v_msg_id where id = r.id;
      v_count := v_count + 1;
    exception when others then
      raise warning 'chat_ai_analysis_live_timeouts: dispatch % failed: %', r.id, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$fn$;

revoke all on function public.chat_ai_analysis_live_timeouts() from public, anon, authenticated;
grant execute on function public.chat_ai_analysis_live_timeouts() to postgres, service_role;

-- 毎分の見張りは既存の high-frequency-dispatcher-cron-job にまとめる（単独ジョブは増やさない）。
-- 以下は 20261001030000 の定義に「最新を調べる」の見張りの呼び出しを足したもの。
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

  -- 「AI分析」Bot の「最新を調べる」の見張り（20分たっても答えが届かなければ「2」を案内する。毎分）
  begin
    perform public.chat_ai_analysis_live_timeouts();
  exception when others then
    raise warning 'high-frequency dispatcher: ai-analysis-live-timeouts failed: %', sqlerrm;
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
