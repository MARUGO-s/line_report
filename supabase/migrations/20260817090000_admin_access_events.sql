-- 管理画面のアクセス／操作履歴。公開 Pages からは読ませず、admin-api（service_role）のみ。
create table if not exists public.admin_access_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  event_kind text not null,
  action text not null,
  page text,
  method text,
  api_path text,
  store_partition_key text,
  actor_kind text not null,
  actor_label text not null,
  line_user_id text,
  ip text,
  user_agent text,
  detail jsonb not null default '{}'::jsonb
);

create index if not exists admin_access_events_created_idx
  on public.admin_access_events (created_at desc);

create index if not exists admin_access_events_store_created_idx
  on public.admin_access_events (store_partition_key, created_at desc);

create index if not exists admin_access_events_action_created_idx
  on public.admin_access_events (action, created_at desc);

alter table public.admin_access_events enable row level security;
revoke all on table public.admin_access_events from anon, authenticated;

comment on table public.admin_access_events is
  '管理画面のログイン・画面表示・操作履歴。admin-api が service_role で書き込む。';
