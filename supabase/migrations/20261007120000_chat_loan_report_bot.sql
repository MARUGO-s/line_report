-- M-talk: 貸借管理アプリ（MARUGO-s/management）の月次「重複チェック」報告を届ける専用Bot「貸借管理 報告」。
--
-- - Bot は「AI分析」（…b073）と同じ形式の auth.users（ログイン不可: banned_until = infinity、@marugo.invalid）。
--   store_key は持たない（店舗Botではないため chat-knowledge の起動対象にならず、店舗ルームにも入れない）。
--   chat_users への追加で chat_create_default_user_access が利用可（approved）の行を作る。
-- - 報告には全店舗の取引情報が載るため、このBotとの1対1・ルームへの招待は「現在の全権管理者」だけに許す。
--   chat_shares_affiliation にこのBotの例外を足すと、既存の chat_open_direct（1対1）と
--   chat_user_can_join_group_by_store（招待）が同じ判定を使う。店舗ルームは既存どおり Bot の store_key と
--   ルームの店舗が一致しないと入れないので、店舗に属さないルームだけに招待できる。
-- - 投稿は mtalk-loan-report（LOAN_MTALK_TOKEN + HMAC）が、全権管理者との1対1（chat_ensure_bot_direct）と
--   Botが参加しているルームへ行う。

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
  '00000000-0000-4000-8000-00000000b074',
  'authenticated',
  'authenticated',
  'loan-report-bot@marugo.invalid',
  extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')),
  now(),
  now(),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"bot":true,"loan_report":true}'::jsonb,
  false,
  false,
  'infinity'
)
on conflict (id) do nothing;

insert into public.chat_users (id, username, is_bot)
values ('00000000-0000-4000-8000-00000000b074', '貸借管理 報告', true)
on conflict (id) do update
  set is_bot = true,
      username = excluded.username;

comment on column public.chat_users.is_bot is
  'Bot。…b071 予約通知、…b072 管理者通知、…b073 AI分析（外部のAI分析レポート配信）、…b074 貸借管理 報告（貸借管理アプリの重複チェック報告。全権管理者だけ1対1・招待可）、store_key 付きは店舗Bot。';

create or replace function public.chat_shares_affiliation(p_a uuid, p_b uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $fn$
declare
  v_bot boolean;
  v_store text;
  v_loan_report_bot constant uuid := '00000000-0000-4000-8000-00000000b074';
begin
  if p_a is null or p_b is null or p_a = p_b then
    return false;
  end if;

  -- 「貸借管理 報告」Bot は全店舗の取引情報を扱うため、相手が現在の全権管理者のときだけ
  if p_b = v_loan_report_bot then
    return public.chat_is_full_admin(p_a);
  end if;
  if p_a = v_loan_report_bot then
    return public.chat_is_full_admin(p_b);
  end if;

  select coalesce(is_bot, false), nullif(btrim(store_key), '')
    into v_bot, v_store
  from public.chat_users
  where id = p_b;
  if not found then return false; end if;

  if v_bot then
    if v_store is null then return false; end if;
    return exists (
      select 1 from public.chat_user_stores s
      where s.user_id = p_a and s.store_key = v_store
    );
  end if;

  select coalesce(is_bot, false), nullif(btrim(store_key), '')
    into v_bot, v_store
  from public.chat_users
  where id = p_a;
  if not found then return false; end if;
  if v_bot then
    if v_store is null then return false; end if;
    return exists (
      select 1 from public.chat_user_stores s
      where s.user_id = p_b and s.store_key = v_store
    );
  end if;

  return exists (
    select 1
    from public.chat_user_stores a
    join public.chat_user_stores b on b.store_key = a.store_key
    where a.user_id = p_a and b.user_id = p_b
  );
end;
$fn$;

revoke all on function public.chat_shares_affiliation(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.chat_shares_affiliation(uuid, uuid)
  to postgres, service_role;

comment on function public.chat_shares_affiliation(uuid, uuid) is
  '2人（またはBotと利用者）が同じ店舗に所属しているか。店舗Botは店舗の所属者、「貸借管理 報告」Bot（…b074）は現在の全権管理者だけ。chat_open_direct・招待の判定に使う。';
