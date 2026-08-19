-- LINE へ送っている予約通知を chat.html にも「カード」として流すための土台。
--
-- 追加するもの:
--   ① chat_messages.kind / payload … カード表示用の構造化ペイロード
--   ② 予約Bot ユーザー               … cron から発言させるための送信者
--   ③ room_summary_settings.chat_group_id … LINEルーム → chatグループの対応表
--
-- content には従来どおりプレーンテキスト版が入る。トーク一覧のプレビュー、
-- Web Push の本文、カード非対応の古いクライアントはすべて content を見るため、
-- payload が読めなくても表示が壊れない。

-- ① カード用カラム ------------------------------------------------------------

alter table public.chat_messages
  add column if not exists kind text not null default 'text',
  add column if not exists payload jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chat_messages_kind_check'
  ) then
    alter table public.chat_messages
      add constraint chat_messages_kind_check check (kind in ('text', 'card'));
  end if;
end
$$;

comment on column public.chat_messages.kind is
  'text=通常の発言 / card=Botが送る構造化カード。payload はカードのときだけ入る。';
comment on column public.chat_messages.payload is
  'カード表示用の構造化データ。{v,kind,cards:[{header,sections,action}]} 形式。';

-- 一般ユーザーがカードを詐称できないようにする。
-- auth.uid() があるリクエスト（＝ブラウザからの発言）は必ず text に落とす。
-- service_role からの投入（auth.uid() が null）だけが card を作れる。
create or replace function public.chat_set_message_author()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is not null then
    new.user_id := auth.uid();
    select username into new.username from public.chat_users where id = auth.uid();
    -- クライアントからのカード詐称を封じる。
    new.kind := 'text';
    new.payload := null;
  end if;

  if new.username is null then
    raise exception 'チャットのプロフィールがありません';
  end if;

  if new.kind = 'card' and new.payload is null then
    raise exception 'カードには payload が必要です';
  end if;

  new.created_at := now();
  return new;
end;
$fn$;

-- ② 予約Bot ------------------------------------------------------------------
--
-- chat_messages.user_id → chat_users(id) → auth.users(id) の FK があるため、
-- Bot にも auth ユーザーが要る。ログインさせる気はないので banned_until=infinity で
-- 封じ、メールは受信不能な予約済みTLD(.invalid, RFC 2606)にしておく。

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at,
  raw_app_meta_data,
  raw_user_meta_data,
  is_sso_user,
  is_anonymous,
  banned_until
) values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-4000-8000-00000000b071',
  'authenticated',
  'authenticated',
  'reservation-bot@marugo.invalid',
  extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')),
  now(),
  now(),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"bot":true}'::jsonb,
  false,
  false,
  'infinity'
)
on conflict (id) do nothing;

-- chat_users_allowed_email トリガは auth.uid() が null なら素通しするので、
-- 許可リストに載せずにプロフィールを作れる（Bot は自分でログインしない）。
insert into public.chat_users (id, username)
values ('00000000-0000-4000-8000-00000000b071', '予約通知')
on conflict (id) do nothing;

-- ③ LINEルーム → chatグループの対応 -------------------------------------------

alter table public.room_summary_settings
  add column if not exists chat_group_id bigint
    references public.chat_groups(id) on delete set null;

comment on column public.room_summary_settings.chat_group_id is
  'このLINEルーム宛の予約通知を、chat.html のどのトークルームにも複製するか。null なら複製しない。';

create index if not exists idx_room_summary_settings_chat_group
  on public.room_summary_settings (chat_group_id)
  where chat_group_id is not null;

-- 最初の対応付け: LINE「マルゴ予約」ルーム → chat.html「マルゴセカンド予約」。
-- id 直書きを避けて名前で引く。該当が無ければ何も起きない。
update public.room_summary_settings s
set chat_group_id = g.id
from public.chat_groups g
where s.room_id = 'Cb508b3d20f2d503739a2b0d30dc7274a'
  and g.group_name = 'マルゴセカンド予約'
  and g.is_direct = false
  and s.chat_group_id is null;
