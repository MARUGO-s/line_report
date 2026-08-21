-- 1人が同じメッセージへ付けられるリアクションは1つだけにする。
-- 既存の複数リアクションは、最後に付けた1件を残して整理する。
with ranked as (
  select
    ctid,
    row_number() over (
      partition by message_id, user_id
      order by created_at desc, emoji desc
    ) as position
  from public.chat_message_reactions
)
delete from public.chat_message_reactions reactions
using ranked
where reactions.ctid = ranked.ctid
  and ranked.position > 1;

alter table public.chat_message_reactions
  drop constraint if exists chat_message_reactions_pkey;

alter table public.chat_message_reactions
  add constraint chat_message_reactions_pkey primary key (message_id, user_id);

-- 別の絵文字を選んだ場合は、同じ行のemojiを置き換える。
create policy chat_reactions_update_self on public.chat_message_reactions
  for update to authenticated
  using (
    user_id = auth.uid()
    and public.chat_is_member_of_message(message_id)
  )
  with check (
    user_id = auth.uid()
    and public.chat_is_member_of_message(message_id)
    and char_length(emoji) between 1 and 16
  );
