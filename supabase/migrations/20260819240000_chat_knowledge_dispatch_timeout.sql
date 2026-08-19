-- chat-knowledge は Gemini 分類を含むため、pg_net 既定の 5 秒だとクライアント側が切れる。
-- 関数本体は切断後も動き続けることがあるが、無反応再発を避けるため 60 秒待つ。
create or replace function public.chat_enqueue_knowledge_dispatch()
returns trigger
language plpgsql
security definer
set search_path = public, net, pg_catalog
as $fn$
declare
  v_secret text;
begin
  if new.user_id = '00000000-0000-4000-8000-00000000b071'::uuid then
    return new;
  end if;
  if not exists (
    select 1 from public.chat_groups g
    where g.id = new.group_id and g.is_store_room
  ) then
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
    body := jsonb_build_object('message_id', new.id),
    timeout_milliseconds := 60000
  );
  return new;
exception
  when others then
    return new;
end;
$fn$;
