-- Google スプレッドシート連携（1店舗パイロット: bistrocavacava）— 新サイト hocbn

create table if not exists public.receipt_sheets_past_sales_export_snapshot (
  store_partition_key text not null,
  sales_month text not null,
  gross_sales_yen bigint not null,
  party_count bigint,
  guest_count bigint,
  operating_days_count bigint,
  exported_at timestamptz not null default now(),
  constraint receipt_sheets_past_sales_snapshot_pk
    primary key (store_partition_key, sales_month),
  constraint receipt_sheets_past_sales_snapshot_month_chk
    check (sales_month ~ '^\d{4}-\d{2}$')
);

comment on table public.receipt_sheets_past_sales_export_snapshot is
  '過去売上の直近シート書出内容。双方向同期でシートが古い写しかシート手修正かを判定する';

create or replace function public.invoke_receipt_sheets_sync_cron()
returns void
language plpgsql
security definer
as $$
declare
  edge_function_url text;
  cron_auth_token text;
  request_id bigint;
begin
  edge_function_url := nullif(current_setting('custom.receipt_sheets_sync_edge_function_url', true), '');
  if edge_function_url is null then
    edge_function_url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/receipt-sheets-sync-cron';
  end if;

  cron_auth_token := public.resolve_edge_cron_auth_token();
  if cron_auth_token is null then
    raise warning 'invoke_receipt_sheets_sync_cron skipped: cron auth token is not configured';
    return;
  end if;

  select net.http_post(
    url := edge_function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || cron_auth_token
    ),
    body := jsonb_build_object('direction', 'both')
  ) into request_id;

  raise log 'invoke_receipt_sheets_sync_cron: Triggered Edge Function at %, request_id=%', edge_function_url, request_id;
end;
$$;

do $$
begin
  begin
    perform cron.unschedule('receipt-sheets-sync-cron-job');
  exception
    when others then
      null;
  end;
end
$$;

select cron.schedule(
  'receipt-sheets-sync-cron-job',
  '15 * * * *',
  $$ select public.invoke_receipt_sheets_sync_cron(); $$
);
