-- M-talk: 外部アプリ（gourmet / Review Command Center の AI分析）から、指定した利用者へ
-- 分析レポートを届ける専用Bot「AI分析」と、Bot↔利用者の1対1を用意するRPC。
--
-- - Bot は予約通知（…b071）・管理者通知（…b072）と同じ形式の auth.users（ログイン不可:
--   banned_until = infinity、@marugo.invalid）。store_key は持たない（店舗Botではないため
--   chat-knowledge の起動対象にならない）。
-- - chat_ensure_bot_direct は service_role 専用。mtalk-external-post（外部トークンとHMACで認証）
--   だけが呼ぶ。相手は有効な（利用停止・削除されていない）人間の利用者に限る。
-- - 既存の1対1は作り直さず再利用し、利用者が非表示・ゴミ箱にしていたら戻す（届いたことが分かるように）。
-- - カードの kind（'ai_report_share'）は chat_messages 側に制約が無いので追加の許可は不要。
--   ファイル（PDF）は既存の kind = 'file' と chat-images バケット（groups/<group_id>/…、PDF可、25MB）を使う。

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
  '00000000-0000-4000-8000-00000000b073',
  'authenticated',
  'authenticated',
  'ai-analysis-bot@marugo.invalid',
  extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')),
  now(),
  now(),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"bot":true,"ai_analysis":true}'::jsonb,
  false,
  false,
  'infinity'
)
on conflict (id) do nothing;

insert into public.chat_users (id, username, is_bot)
values ('00000000-0000-4000-8000-00000000b073', 'AI分析', true)
on conflict (id) do update
  set is_bot = true,
      username = excluded.username;

comment on column public.chat_users.is_bot is
  'Bot。…b071 予約通知、…b072 管理者通知、…b073 AI分析（外部のAI分析レポート配信）、store_key 付きは店舗Bot。';

create or replace function public.chat_ensure_bot_direct(p_bot uuid, p_user uuid)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
declare
  v_key text;
  v_id bigint;
  v_bot_name text;
begin
  if p_bot is null or p_user is null or p_bot = p_user then
    raise exception using errcode = '22023', message = '1対1の相手が不正です';
  end if;

  select u.username into v_bot_name
  from public.chat_users u
  where u.id = p_bot
    and coalesce(u.is_bot, false)
    and u.bot_deleted_at is null
    and nullif(btrim(coalesce(u.store_key, '')), '') is null;
  if v_bot_name is null then
    raise exception using errcode = '22023', message = '送信元のBotが見つかりません';
  end if;

  if not exists (
    select 1 from public.chat_users u
    where u.id = p_user and coalesce(u.is_bot, false) = false
  ) or not public.chat_has_active_access(p_user) then
    raise exception using errcode = '22023', message = '送信先の利用者が見つからないか、利用停止中です';
  end if;

  if p_user::text < p_bot::text then
    v_key := p_user::text || ':' || p_bot::text;
  else
    v_key := p_bot::text || ':' || p_user::text;
  end if;

  select g.id into v_id
  from public.chat_groups g
  where g.direct_key = v_key and g.is_direct
  for update;

  if v_id is null then
    insert into public.chat_groups (group_name, created_by, is_direct, direct_key)
    values (v_bot_name, p_bot, true, v_key)
    on conflict do nothing
    returning id into v_id;
    if v_id is null then
      select g.id into v_id
      from public.chat_groups g
      where g.direct_key = v_key and g.is_direct;
    end if;
  elsif exists (
    select 1 from public.chat_groups g where g.id = v_id and g.trashed_at is not null
  ) then
    perform set_config('chat.allow_trash', '1', true);
    update public.chat_groups
    set trashed_at = null,
        trashed_by = null
    where id = v_id;
  end if;

  perform set_config('chat.allow_member_permission_update', '1', true);

  insert into public.chat_group_members (
    group_id, user_id, can_view, can_send, can_invite, can_manage
  ) values
    (v_id, p_bot, true, true, false, false),
    (v_id, p_user, true, true, false, false)
  on conflict (group_id, user_id) do update
    set can_view = true,
        hidden_at = null;

  return v_id;
end;
$fn$;

revoke all on function public.chat_ensure_bot_direct(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.chat_ensure_bot_direct(uuid, uuid) to service_role;

comment on function public.chat_ensure_bot_direct(uuid, uuid) is
  'service_role専用。店舗に属さないBot（AI分析など）と有効な利用者の1対1を作成または再利用し、非表示・ゴミ箱を戻して group_id を返す。';
