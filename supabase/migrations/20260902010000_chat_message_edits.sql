-- 自分の発言の本文を後から直せるようにする。
-- 誤送信の訂正が削除しかない状態を、テキストと文章付きスタンプに限って解消する。
--
-- 変えてよいのは content / mentions / edited_at だけ。
-- 直す前の本文は edit_history へサーバ側で積み、クライアントから消せない。
-- kind・画像パス・カード・送信者・ルーム・作成時刻・返信先・サイレントは固定。
-- INSERT専用の Push / 資料登録トリガは動かない。通知のやり直しも Bot の再応答もしない。

alter table public.chat_messages
  add column if not exists edited_at timestamptz,
  add column if not exists edit_history jsonb not null default '[]'::jsonb;

comment on column public.chat_messages.edited_at is
  '本文を直した時刻。null なら未編集。';
comment on column public.chat_messages.edit_history is
  '直す前の本文の履歴。取り消し線表示用。クライアントは書き換え不可。';

-- UPDATE の Realtime で本文が欠けるのを防ぐ。
alter table public.chat_messages replica identity full;

drop trigger if exists chat_messages_reject_trashed on public.chat_messages;
create trigger chat_messages_reject_trashed
before insert or update on public.chat_messages
for each row execute function public.chat_reject_trashed_group_write();

create or replace function public.chat_guard_message_edit()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_sticker_display text;
  v_sticker_label text;
  v_hist jsonb;
  v_first jsonb;
  v_tail jsonb;
begin
  if tg_op <> 'UPDATE' then
    return new;
  end if;

  -- 保護列はクライアント申告を捨て、元の値へ戻す。履歴も申告させない。
  new.id := old.id;
  new.group_id := old.group_id;
  new.user_id := old.user_id;
  new.username := old.username;
  new.kind := old.kind;
  new.payload := old.payload;
  new.created_at := old.created_at;
  new.reply_to_id := old.reply_to_id;
  new.is_silent := old.is_silent;
  v_hist := coalesce(old.edit_history, '[]'::jsonb);
  if jsonb_typeof(v_hist) <> 'array' then
    v_hist := '[]'::jsonb;
  end if;

  if old.kind not in ('text', 'sticker') then
    raise exception 'このメッセージは編集できません';
  end if;

  if old.kind = 'sticker' then
    v_sticker_display := coalesce(old.payload #>> '{sticker,display}', 'large');
    v_sticker_label := coalesce(old.payload #>> '{sticker,label}', '');
    if v_sticker_display <> 'compact' then
      raise exception '大きく送った感情イラストは編集できません';
    end if;
    if nullif(btrim(new.content), '') is null or btrim(new.content) = '[感情イラスト]' then
      new.content := '[感情イラスト] ' || v_sticker_label;
    else
      new.content := left(btrim(new.content), 2000);
    end if;
  else
    if char_length(btrim(coalesce(new.content, ''))) < 1 then
      raise exception '本文を空にはできません';
    end if;
    new.content := left(btrim(new.content), 2000);
  end if;

  if new.mentions is null then
    new.mentions := '{}'::uuid[];
  elsif array_length(new.mentions, 1) is not null then
    select coalesce(array_agg(distinct gm.user_id), '{}'::uuid[])
      into new.mentions
    from public.chat_group_members gm
    where gm.group_id = new.group_id
      and gm.user_id = any(new.mentions);
  end if;

  if new.content is distinct from old.content then
    v_hist := v_hist || jsonb_build_array(jsonb_build_object(
      'content', old.content,
      'at', coalesce(old.edited_at, old.created_at)
    ));
    -- 先頭（最初の本文）は残し、古い途中履歴から削って最大20件。
    if jsonb_array_length(v_hist) > 20 then
      v_first := v_hist -> 0;
      select coalesce(jsonb_agg(elem), '[]'::jsonb)
        into v_tail
      from (
        select elem
        from jsonb_array_elements(v_hist) with ordinality as t(elem, ord)
        where t.ord > (jsonb_array_length(v_hist) - 19)
        order by t.ord
      ) kept;
      v_hist := jsonb_build_array(v_first) || coalesce(v_tail, '[]'::jsonb);
    end if;
  end if;
  new.edit_history := v_hist;
  new.edited_at := now();
  return new;
end;
$fn$;

revoke all on function public.chat_guard_message_edit() from public, anon, authenticated;
grant execute on function public.chat_guard_message_edit() to service_role;

drop trigger if exists chat_messages_guard_edit on public.chat_messages;
create trigger chat_messages_guard_edit
before update on public.chat_messages
for each row execute function public.chat_guard_message_edit();

drop policy if exists chat_messages_update_own on public.chat_messages;
create policy chat_messages_update_own on public.chat_messages
  for update to authenticated
  using (user_id = (select auth.uid()) and public.chat_can_send_group(group_id))
  with check (
    user_id = (select auth.uid())
    and public.chat_can_send_group(group_id)
    and char_length(content) between 1 and 2000
  );
