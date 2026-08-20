-- 招待された店舗Botがいるルームでも、その店舗のレシート解析を動かす。

create or replace function public.chat_enqueue_knowledge_dispatch()
returns trigger
language plpgsql
security definer
set search_path = public, net, pg_catalog
as $fn$
declare
  v_secret text;
  v_store_key text;
  v_bot_keys integer;
begin
  if exists (
    select 1 from public.chat_users u
    where u.id = new.user_id and u.is_bot
  ) then
    return new;
  end if;

  select nullif(trim(g.store_key), '') into v_store_key
  from public.chat_groups g
  where g.id = new.group_id
    and g.is_store_room;

  if v_store_key is null then
    select count(distinct u.store_key), min(u.store_key)
      into v_bot_keys, v_store_key
    from public.chat_group_members m
    join public.chat_users u on u.id = m.user_id
    where m.group_id = new.group_id
      and u.is_bot
      and nullif(trim(u.store_key), '') is not null;
    if v_bot_keys is distinct from 1 then
      v_store_key := null;
    end if;
  end if;

  if v_store_key is null or v_store_key = '' then
    return new;
  end if;

  select dispatch_secret into v_secret
  from public.chat_push_internal_config
  where id = true;

  if v_secret is null or v_secret = '' then
    return new;
  end if;

  perform net.http_post(
    url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/chat-knowledge?action=dispatch',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_secret,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'message_id', new.id,
      'store_key', v_store_key
    ),
    timeout_milliseconds := 60000
  );
  return new;
exception
  when others then
    return new;
end;
$fn$;

drop trigger if exists chat_messages_enqueue_knowledge on public.chat_messages;
create trigger chat_messages_enqueue_knowledge
after insert on public.chat_messages
for each row execute function public.chat_enqueue_knowledge_dispatch();
