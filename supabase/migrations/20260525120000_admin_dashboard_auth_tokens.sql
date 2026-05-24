create table if not exists public.admin_dashboard_auth_tokens (
  id bigserial primary key,
  token_kind text not null check (token_kind in ('login_link', 'session')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_dashboard_auth_tokens_kind_expires_idx
  on public.admin_dashboard_auth_tokens (token_kind, expires_at desc);

alter table public.admin_dashboard_auth_tokens enable row level security;

drop policy if exists "admin_dashboard_auth_tokens_service_role_all"
  on public.admin_dashboard_auth_tokens;

create policy "admin_dashboard_auth_tokens_service_role_all"
  on public.admin_dashboard_auth_tokens
  for all
  using (auth.jwt() ->> 'role' = 'service_role')
  with check (auth.jwt() ->> 'role' = 'service_role');
