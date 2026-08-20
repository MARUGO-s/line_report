-- 店舗Botの発言名を「店名 bot」にする。

update public.chat_messages m
set username = trim(both from regexp_replace(u.username, '\s*bot$', '', 'i')) || ' bot'
from public.chat_users u
where m.user_id = u.id
  and coalesce(u.is_bot, false)
  and u.store_key is not null;
