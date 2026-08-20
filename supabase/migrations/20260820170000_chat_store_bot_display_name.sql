-- 店舗Botの発言表示名を店名ではなく Bot にする。
-- chat_users.username は一意のため店名のまま残し、メッセージ側だけ揃える。

update public.chat_messages m
set username = 'Bot'
from public.chat_users u
where m.user_id = u.id
  and coalesce(u.is_bot, false)
  and u.store_key is not null
  and m.username is distinct from 'Bot';
