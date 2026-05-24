-- 店舗別レシート修正セッション（hocbn line-webhook 用）
create table if not exists public.store_receipt_correction_pending (
  id uuid primary key default gen_random_uuid(),
  conversation_key text not null unique,
  store_partition_key text not null,
  receipt_table text not null,
  receipt_row_id bigint not null,
  room_id text not null,
  user_id text,
  line_message_id text not null,
  stage text not null default 'select_field' check (stage in ('select_field', 'input_value')),
  current_field_key text check (
    current_field_key in ('storeName', 'date', 'netSales', 'taxAmount', 'grossSales', 'partyCount', 'guestCount', 'unitPrice')
  ),
  draft_json jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists store_receipt_correction_pending_expires_idx
  on public.store_receipt_correction_pending (expires_at desc);

create index if not exists store_receipt_correction_pending_store_idx
  on public.store_receipt_correction_pending (store_partition_key);

alter table public.store_receipt_correction_pending enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'store_receipt_correction_pending'
      and policyname = 'Service role can do everything on store_receipt_correction_pending'
  ) then
    create policy "Service role can do everything on store_receipt_correction_pending"
      on public.store_receipt_correction_pending
      for all
      using (auth.jwt() ->> 'role' = 'service_role');
  end if;
end;
$$;
