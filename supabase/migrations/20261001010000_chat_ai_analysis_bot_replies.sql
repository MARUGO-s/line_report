-- M-talk: 「AI分析」Bot（…b073）との1対1に利用者が書いた文章へ、Bot が gourmet の AI分析で答える。
--
-- - chat_messages への追加のたびに、対象（1対1で相手が AI分析Bot、送信者が人間、kind = 'text'、本文あり）だけを
--   pg_net で mtalk-external-post /chat-dispatch へ渡す。認証は chat-search / chat-knowledge と同じ
--   chat_push_internal_config.dispatch_secret（関数入口で定数時間比較）。Bot 自身と他の Bot の発言は渡さない（返信の無限ループ防止）。
-- - 本当に答えるか（利用停止中でないか・同じ発言に二度答えないか）は関数側で改めて確かめる。
-- - 失敗しても元の発言の保存は止めない（例外は握りつぶす）。既存の chat_messages_enqueue_knowledge（店舗Bot向け）とは対象が重ならない。

create or replace function public.chat_enqueue_ai_analysis_reply()
returns trigger
language plpgsql
security definer
set search_path = public, net, pg_catalog
as $fn$
declare
  v_bot constant uuid := '00000000-0000-4000-8000-00000000b073';
  v_secret text;
begin
  if new.user_id is null or new.user_id = v_bot then
    return new;
  end if;
  if coalesce(new.kind, 'text') <> 'text' or nullif(btrim(coalesce(new.content, '')), '') is null then
    return new;
  end if;
  if not exists (
    select 1
    from public.chat_groups g
    where g.id = new.group_id
      and g.is_direct
      and g.trashed_at is null
      and g.direct_key in (v_bot::text || ':' || new.user_id::text, new.user_id::text || ':' || v_bot::text)
  ) then
    return new;
  end if;
  if exists (select 1 from public.chat_users u where u.id = new.user_id and u.is_bot) then
    return new;
  end if;

  select dispatch_secret into v_secret from public.chat_push_internal_config where id = true;
  if v_secret is null or v_secret = '' then
    return new;
  end if;

  perform net.http_post(
    url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/mtalk-external-post/chat-dispatch',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret, 'Content-Type', 'application/json'),
    body := jsonb_build_object('message_id', new.id),
    timeout_milliseconds := 30000
  );
  return new;
exception when others then
  return new;
end;
$fn$;

revoke all on function public.chat_enqueue_ai_analysis_reply() from public, anon, authenticated;
grant execute on function public.chat_enqueue_ai_analysis_reply() to service_role;

comment on function public.chat_enqueue_ai_analysis_reply() is
  '「AI分析」Bot（…b073）との1対1への利用者の文章を mtalk-external-post /chat-dispatch へ渡す（pg_net、dispatch_secret）。Botの発言は渡さない。';

drop trigger if exists chat_messages_enqueue_ai_analysis_reply on public.chat_messages;
create trigger chat_messages_enqueue_ai_analysis_reply
after insert on public.chat_messages
for each row execute function public.chat_enqueue_ai_analysis_reply();
