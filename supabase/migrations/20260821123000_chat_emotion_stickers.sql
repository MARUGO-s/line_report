-- M-talk 感情イラスト: DB台帳から選び、chat_messages.kind='sticker' で履歴保存する。

create table if not exists public.chat_stickers (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  label text not null check (char_length(label) between 1 and 40),
  asset_path text not null unique check (asset_path like 'stickers/face/%.png'),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.chat_stickers enable row level security;
drop policy if exists chat_stickers_select_authenticated on public.chat_stickers;
create policy chat_stickers_select_authenticated on public.chat_stickers
  for select to authenticated using (is_active);
grant select on public.chat_stickers to authenticated;

insert into public.chat_stickers (id, label, asset_path, sort_order) values
  ('stormy', 'しょんぼり', 'stickers/face/1903_rayny_stormy2.png', 1),
  ('sick-10', 'つらい', 'stickers/face/200405_a_sic_10.png', 2),
  ('sick-11', '具合が悪い', 'stickers/face/200405_a_sic_11.png', 3),
  ('sick-12', 'お休みします', 'stickers/face/200405_a_sic_12.png', 4),
  ('angry', '怒っています', 'stickers/face/200516_c_angry01.png', 5),
  ('determination-1', 'やるぞ', 'stickers/face/200516_e_determination02-1.png', 6),
  ('determination-2', 'がんばります', 'stickers/face/200516_e_determination02.png', 7),
  ('banzai', 'ばんざい', 'stickers/face/200605_a_banzai.png', 8),
  ('love', '大好き', 'stickers/face/210102_love04.png', 9),
  ('blown-away', 'びっくり', 'stickers/face/240515__blownaway_together.png', 10),
  ('whirlwind', '大あわて', 'stickers/face/240517_whirlwind.png', 11),
  ('jump-happy', 'うれしい', 'stickers/face/260327_jump_happy1.png', 12),
  ('sit-eat', 'いただきます', 'stickers/face/260421_sit_eat.png', 13),
  ('sit-surprise', 'えっ', 'stickers/face/260421_sit_surprise.png', 14),
  ('mothersday', 'ありがとう', 'stickers/face/260506_mothersday_02.png', 15),
  ('with-flower', 'お花をどうぞ', 'stickers/face/260507_withflower_01.png', 16),
  ('face-smile', 'にっこり', 'stickers/face/b_face_200309_03.png', 17),
  ('face-troubled', '困った', 'stickers/face/b_face_200309_04.png', 18),
  ('face-cry', 'かなしい', 'stickers/face/b_face_200309_05.png', 19),
  ('support', '応援しています', 'stickers/face/c_Support_200309_01.png', 20),
  ('cook', '料理中', 'stickers/face/cook.png', 21),
  ('hang-on', 'ちょっと待って', 'stickers/face/hangon3-897x1000.png', 22),
  ('ill-17-1', '了解です', 'stickers/face/ill_17_s-1.png', 23),
  ('ill-17', 'お願いします', 'stickers/face/ill_17_s.png', 24),
  ('ill-5', 'ごめんなさい', 'stickers/face/ill_5_s.png', 25),
  ('ill-9-1', 'おつかれさま', 'stickers/face/ill_9-1_s.png', 26),
  ('ill-9-2', 'ありがとうございます', 'stickers/face/ill_9-2_s.png', 27),
  ('aff-005', 'ハッピー', 'stickers/face/ill_aff005_l.png', 28),
  ('aff-008', '落ち込み', 'stickers/face/ill_aff008_l-1000x928.png', 29),
  ('aff-010', '考え中', 'stickers/face/ill_aff010_l.png', 30),
  ('aff-012', '怒り', 'stickers/face/ill_aff012_l.png', 31),
  ('aff-014', 'ショック', 'stickers/face/ill_aff014_l.png', 32),
  ('gesture-02', 'いいね', 'stickers/face/ill_c_200222_02.png', 33),
  ('gesture-07', 'おねがい', 'stickers/face/ill_c_200222_07.png', 34),
  ('gesture-08', 'ファイト', 'stickers/face/ill_c_200222_08.png', 35),
  ('joy', '大喜び', 'stickers/face/joy.png', 36),
  ('valentine', '感謝です', 'stickers/face/love-valentine_15-2.png', 37),
  ('question-05', 'どうしよう', 'stickers/face/question_Illustration1904_05.png', 38),
  ('question-12', 'なぜ？', 'stickers/face/question_Illustration1904_12.png', 39)
on conflict (id) do update set
  label = excluded.label, asset_path = excluded.asset_path,
  sort_order = excluded.sort_order, is_active = true;

alter table public.chat_messages drop constraint if exists chat_messages_kind_check;
alter table public.chat_messages
  add constraint chat_messages_kind_check check (kind in ('text', 'card', 'image', 'sticker'));

create or replace function public.chat_set_message_author()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_path text;
  v_w text;
  v_h text;
  v_sticker_id text;
  v_sticker_label text;
  v_sticker_path text;
begin
  if auth.uid() is not null then
    new.user_id := auth.uid();
    select username into new.username from public.chat_users where id = auth.uid();

    if new.kind is null or new.kind not in ('text', 'image', 'sticker') then new.kind := 'text'; end if;
    if new.kind = 'text' then
      new.payload := null;
    elsif new.kind = 'image' then
      v_path := nullif(new.payload #>> '{image,path}', '');
      if v_path is null or v_path not like 'groups/' || new.group_id::text || '/%' then
        raise exception '画像メッセージの保存先が不正です';
      end if;
      v_w := nullif(regexp_replace(coalesce(new.payload #>> '{image,w}', ''), '\D', '', 'g'), '');
      v_h := nullif(regexp_replace(coalesce(new.payload #>> '{image,h}', ''), '\D', '', 'g'), '');
      new.payload := jsonb_strip_nulls(jsonb_build_object('v', 1, 'kind', 'image', 'image',
        jsonb_strip_nulls(jsonb_build_object('path', v_path,
          'w', case when v_w is null then null else to_jsonb(v_w::int) end,
          'h', case when v_h is null then null else to_jsonb(v_h::int) end))));
    else
      v_sticker_id := nullif(new.payload #>> '{sticker,id}', '');
      select label, asset_path into v_sticker_label, v_sticker_path
      from public.chat_stickers where id = v_sticker_id and is_active;
      if v_sticker_path is null then raise exception '利用できない感情イラストです'; end if;
      new.content := '[感情イラスト] ' || v_sticker_label;
      new.payload := jsonb_build_object('v', 1, 'kind', 'sticker', 'sticker',
        jsonb_build_object('id', v_sticker_id, 'label', v_sticker_label, 'path', v_sticker_path));
    end if;
  end if;

  if new.username is null then raise exception 'チャットのプロフィールがありません'; end if;
  if new.kind in ('card', 'image', 'sticker') and new.payload is null then
    raise exception 'このメッセージ種別には payload が必要です';
  end if;
  if new.reply_to_id is not null and not exists (
    select 1 from public.chat_messages where id = new.reply_to_id and group_id = new.group_id
  ) then raise exception '返信先の発言が同じトークルームにありません'; end if;
  if new.mentions is null then
    new.mentions := '{}'::uuid[];
  elsif array_length(new.mentions, 1) is not null then
    select coalesce(array_agg(distinct gm.user_id), '{}'::uuid[]) into new.mentions
    from public.chat_group_members gm
    where gm.group_id = new.group_id and gm.user_id = any(new.mentions);
  end if;
  new.created_at := now();
  return new;
end;
$fn$;

comment on table public.chat_stickers is 'M-talkで送れる感情イラストのDB台帳。画像本体は公開Pages資産、送信履歴はchat_messages payloadへ保存。';

-- 感情イラストは会話表現であり、店舗Botの検索・レシート解析へ渡さない。
drop trigger if exists chat_messages_enqueue_knowledge on public.chat_messages;
create trigger chat_messages_enqueue_knowledge
after insert on public.chat_messages
for each row
when (new.kind <> 'sticker')
execute function public.chat_enqueue_knowledge_dispatch();
