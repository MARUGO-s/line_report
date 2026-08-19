-- 自分の発言だけ削除できるようにする（操作メニューの「削除」用）。

drop policy if exists chat_messages_delete_own on public.chat_messages;
create policy chat_messages_delete_own on public.chat_messages
  for delete to authenticated
  using (user_id = auth.uid());

comment on policy chat_messages_delete_own on public.chat_messages is
  'ログイン中ユーザーは自分の発言だけ消せる。';
