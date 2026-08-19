-- public/chat.html の Web Push 購読と、メッセージ単位の送信重複防止。
-- 購読 endpoint / p256dh / auth は端末固有の秘密情報に近いため、
-- 公開 Pages からテーブルを直接触らせず chat-push Edge Function だけが service_role で操作する。

create table if not exists public.chat_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.chat_users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_secret text not null,
  expiration_time timestamptz,
  user_agent text,
  preview_enabled boolean not null default true,
  is_active boolean not null default true,
  failure_count integer not null default 0,
  last_seen_at timestamptz not null default now(),
  last_success_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_push_endpoint_https check (
    endpoint ~ '^https://'
    and char_length(endpoint) between 12 and 2048
  ),
  constraint chat_push_p256dh_length check (char_length(p256dh) between 40 and 512),
  constraint chat_push_auth_length check (char_length(auth_secret) between 16 and 256),
  constraint chat_push_user_agent_length check (
    user_agent is null or char_length(user_agent) <= 1000
  ),
  constraint chat_push_failure_count_nonnegative check (failure_count >= 0)
);

create index if not exists chat_push_subscriptions_user_active_idx
  on public.chat_push_subscriptions (user_id, is_active);

alter table public.chat_push_subscriptions enable row level security;
revoke all on table public.chat_push_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on table public.chat_push_subscriptions to service_role;

create table if not exists public.chat_push_user_preferences (
  user_id uuid primary key references public.chat_users(id) on delete cascade,
  notifications_enabled boolean not null default true,
  preview_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.chat_push_user_preferences enable row level security;
revoke all on table public.chat_push_user_preferences from public, anon, authenticated;
grant select on table public.chat_push_user_preferences to authenticated;
grant select, insert, update, delete on table public.chat_push_user_preferences to service_role;

create policy chat_push_user_preferences_select_self
  on public.chat_push_user_preferences
  for select to authenticated
  using (user_id = (select auth.uid()));

create table if not exists public.chat_push_dispatches (
  message_id bigint primary key references public.chat_messages(id) on delete cascade,
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  sent_count integer not null default 0,
  failure_count integer not null default 0,
  last_error text,
  constraint chat_push_dispatch_counts_nonnegative check (
    sent_count >= 0 and failure_count >= 0
  )
);

alter table public.chat_push_dispatches enable row level security;
revoke all on table public.chat_push_dispatches from public, anon, authenticated;
grant select, insert, update, delete on table public.chat_push_dispatches to service_role;

-- DBトリガーとchat-pushだけが共有する内部シークレット。
-- migration適用時に生成し、公開Data APIからは読めない。
create table if not exists public.chat_push_internal_config (
  id boolean primary key default true check (id),
  dispatch_secret text not null,
  created_at timestamptz not null default now(),
  constraint chat_push_dispatch_secret_length check (char_length(dispatch_secret) >= 64)
);

alter table public.chat_push_internal_config enable row level security;
revoke all on table public.chat_push_internal_config from public, anon, authenticated;
grant select on table public.chat_push_internal_config to service_role;

insert into public.chat_push_internal_config (id, dispatch_secret)
values (true, encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (id) do nothing;

create or replace function public.chat_get_vapid_config()
returns jsonb
language sql
stable
security definer
set search_path = vault, pg_catalog
as $fn$
  select ds.decrypted_secret::jsonb
  from vault.decrypted_secrets as ds
  where ds.name = 'chat_vapid_config'
  limit 1
$fn$;

revoke all on function public.chat_get_vapid_config() from public, anon, authenticated;
grant execute on function public.chat_get_vapid_config() to service_role;

-- 同じメッセージに対するブラウザ再試行・二重クリック・並行呼び出しを1回にまとめる。
-- 処理途中でEdge Functionが落ちた場合だけ、5分後に再取得できる。
create or replace function public.chat_claim_push_dispatch(p_message_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_message_id bigint;
begin
  if p_message_id is null or p_message_id <= 0 then
    return false;
  end if;

  insert into public.chat_push_dispatches (message_id, claimed_at)
  values (p_message_id, now())
  on conflict (message_id) do update
    set claimed_at = excluded.claimed_at,
        last_error = null
    where chat_push_dispatches.completed_at is null
      and chat_push_dispatches.claimed_at < now() - interval '5 minutes'
  returning message_id into v_message_id;

  return v_message_id is not null;
end;
$fn$;

revoke all on function public.chat_claim_push_dispatch(bigint) from public, anon, authenticated;
grant execute on function public.chat_claim_push_dispatch(bigint) to service_role;

-- INSERT成功後に非同期HTTPをキューへ積む。通知側の障害でメッセージ保存は失敗させない。
create or replace function public.chat_enqueue_push_dispatch()
returns trigger
language plpgsql
security definer
set search_path = public, net, pg_catalog
as $fn$
declare
  v_secret text;
begin
  select dispatch_secret
    into v_secret
  from public.chat_push_internal_config
  where id = true;

  if v_secret is null or v_secret = '' then
    return new;
  end if;

  perform net.http_post(
    url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/chat-push?action=dispatch',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_secret,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('message_id', new.id)
  );
  return new;
exception
  when others then
    return new;
end;
$fn$;

revoke all on function public.chat_enqueue_push_dispatch() from public, anon, authenticated;

drop trigger if exists chat_messages_enqueue_push on public.chat_messages;
create trigger chat_messages_enqueue_push
after insert on public.chat_messages
for each row execute function public.chat_enqueue_push_dispatch();

do $publication$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'chat_push_user_preferences'
  ) then
    alter publication supabase_realtime add table public.chat_push_user_preferences;
  end if;
end
$publication$;

comment on table public.chat_push_subscriptions is
  'Web Push端末購読。chat-push Edge Functionからのみ操作し、公開Data APIへは露出しない。';
comment on table public.chat_push_user_preferences is
  'ユーザー共通の通知ON/OFFと本文プレビュー設定。本人はRLS下で設定値だけ参照でき、更新はchat-push経由。';
comment on table public.chat_push_dispatches is
  'chat_messages単位のWeb Push送信重複防止・結果記録。';
comment on table public.chat_push_internal_config is
  'chat_messages AFTER INSERTトリガーとchat-push間の内部認証情報。';
