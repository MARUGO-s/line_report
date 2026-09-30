-- レシート解析削除の確認待ち状態（hocbn line-webhook 用）
create table if not exists public.store_receipt_delete_pending (
  id uuid primary key default gen_random_uuid(),
  conversation_key text not null unique,
  receipt_table text not null,
  room_id text not null,
  user_id text,
  target_line_message_id text,
  target_receipt_row_id bigint,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint store_receipt_delete_pending_target_check
    check (target_line_message_id is not null or target_receipt_row_id is not null)
);

create index if not exists store_receipt_delete_pending_expires_idx
  on public.store_receipt_delete_pending (expires_at desc);

alter table public.store_receipt_delete_pending enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'store_receipt_delete_pending'
      and policyname = 'Service role can do everything on store_receipt_delete_pending'
  ) then
    create policy "Service role can do everything on store_receipt_delete_pending"
      on public.store_receipt_delete_pending
      for all
      using (auth.jwt() ->> 'role' = 'service_role');
  end if;
end;
$$;
