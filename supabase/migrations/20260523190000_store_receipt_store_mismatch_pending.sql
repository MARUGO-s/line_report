-- 店名不一致確認の保留状態（hocbn line-webhook 用）
create table if not exists public.store_receipt_store_mismatch_pending (
  id uuid primary key default gen_random_uuid(),
  conversation_key text not null unique,
  store_partition_key text not null,
  receipt_table text not null,
  room_id text not null,
  user_id text,
  line_message_id text not null,
  receipt_date date not null,
  registered_store_name text not null,
  parsed_store_name text not null,
  receipt_payload jsonb not null default '{}'::jsonb,
  summary_text text,
  store_display_name text,
  sender_display_name text,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists store_receipt_store_mismatch_pending_expires_idx
  on public.store_receipt_store_mismatch_pending (expires_at desc);

alter table public.store_receipt_store_mismatch_pending enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'store_receipt_store_mismatch_pending'
      and policyname = 'Service role can do everything on store_receipt_store_mismatch_pending'
  ) then
    create policy "Service role can do everything on store_receipt_store_mismatch_pending"
      on public.store_receipt_store_mismatch_pending
      for all
      using (auth.jwt() ->> 'role' = 'service_role');
  end if;
end;
$$;
