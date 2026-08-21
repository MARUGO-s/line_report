-- 定型の検索メニューと検索種別選択は、画像・レシート解析を含む重い
-- chat-knowledge を起動せず、軽量な chat-search へ直接振り分ける。

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
  v_url text;
  v_text text;
begin
  if exists (select 1 from public.chat_users u where u.id = new.user_id and u.is_bot) then
    return new;
  end if;

  select nullif(trim(g.store_key), '') into v_store_key
  from public.chat_groups g
  where g.id = new.group_id and g.is_store_room;

  if v_store_key is null then
    select count(distinct u.store_key), min(u.store_key)
      into v_bot_keys, v_store_key
    from public.chat_group_members m
    join public.chat_users u on u.id = m.user_id
    where m.group_id = new.group_id
      and u.is_bot
      and nullif(trim(u.store_key), '') is not null;
    if v_bot_keys is distinct from 1 then v_store_key := null; end if;
  end if;

  if v_store_key is null or v_store_key = '' then return new; end if;
  select dispatch_secret into v_secret from public.chat_push_internal_config where id = true;
  if v_secret is null or v_secret = '' then return new; end if;

  v_text := regexp_replace(trim(coalesce(new.content, '')), '\s+', '', 'g');
  if v_text = any (array[
    '検索','検索ヘルプ','検索の仕方','検索方法','search',
    'ヘルプ','使い方','help','キャンセル','やめる','cancel',
    '会話検索','トーク検索','会話を検索','予定検索','カレンダー検索','予定を検索',
    'メディア検索','画像検索','ファイル検索','売上検索','売り上げ検索','レシート検索',
    'srch=menu','srch=help','srch=cancel','srch=msg','srch=cal','srch=med','srch=sal'
  ]) then
    v_url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/chat-search';
  else
    v_url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/chat-knowledge?action=dispatch';
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret, 'Content-Type', 'application/json'),
    body := jsonb_build_object('message_id', new.id, 'store_key', v_store_key),
    timeout_milliseconds := 60000
  );
  return new;
exception when others then
  return new;
end;
$fn$;

drop trigger if exists chat_messages_enqueue_knowledge on public.chat_messages;
create trigger chat_messages_enqueue_knowledge
after insert on public.chat_messages
for each row execute function public.chat_enqueue_knowledge_dispatch();
