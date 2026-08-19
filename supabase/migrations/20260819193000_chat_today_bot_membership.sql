-- 予約Bot を、LINE予約通知の複製先トークのメンバーにする。
-- 発言 insert 自体は service_role で通るが、一覧や既読の前提として参加させておく。

insert into public.chat_group_members (group_id, user_id)
select s.chat_group_id, '00000000-0000-4000-8000-00000000b071'::uuid
from public.room_summary_settings s
where s.chat_group_id is not null
on conflict (group_id, user_id) do nothing;
