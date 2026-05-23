-- 一回限り: jhpm → hocbn Secret コピー用ステージング（コピー後に削除）

create table if not exists public.migration_secret_staging (
  secret_name text primary key,
  secret_value text not null,
  copied_at timestamptz not null default now()
);

alter table public.migration_secret_staging enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'migration_secret_staging'
      and policyname = 'Service role can do everything on migration_secret_staging'
  ) then
    create policy "Service role can do everything on migration_secret_staging"
      on public.migration_secret_staging for all
      using (auth.jwt() ->> 'role' = 'service_role');
  end if;
end;
$$;
