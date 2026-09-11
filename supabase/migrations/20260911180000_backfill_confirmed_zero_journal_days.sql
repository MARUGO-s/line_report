-- Recover only absent, unambiguous, explicitly parsed zero days for sync-enabled stores.
-- No original report, receipt, manual correction, existing day or sync setting is changed.
-- Source totals and parsed facts must agree. Repeated application is a no-op.
insert into public.line_sales_manual_day
  (store_partition_key, sales_date, gross_sales_yen, tax_amount_yen, guest_count,
   party_count, source, journal_values, manual_values)
select s.store_partition_key, p.business_date, 0, 0, 0, 0, 'journal',
  '{"gross_sales_yen":0,"tax_amount_yen":0,"guest_count":0,"party_count":0}'::jsonb, '{}'::jsonb
from public.pos_journal_files p
join public.store_webhook_tables s on lower(s.store_partition_key)=lower(p.store_partition_key)
join public.store_operation_profiles ops on ops.store_partition_key=lower(s.store_partition_key)
where ops.profile->'journalSalesSync' = 'true'::jsonb
  and p.storage_deleted_at is null
  and p.parsed_data->'parsed_complete' = 'true'::jsonb
  and p.gross_sales=0 and p.net_sales=0 and p.tax_yen=0
  and p.groups_count=0 and p.guests_count=0 and p.receipts_count=0
  and p.parsed_data->'gross_sales'='0'::jsonb and p.parsed_data->'tax'='0'::jsonb
  and p.parsed_data->'guests'='0'::jsonb and p.parsed_data->'groups'='0'::jsonb
  and p.parsed_data->'receipts'='[]'::jsonb
  and p.parsed_data->>'business_date'=p.business_date::text
  and not exists (select 1 from public.pos_journal_files other
    where lower(other.store_partition_key)=lower(p.store_partition_key)
      and other.business_date=p.business_date and other.storage_deleted_at is null and other.id<>p.id)
  and not exists (select 1 from public.line_sales_manual_day d
    where lower(d.store_partition_key)=lower(s.store_partition_key) and d.sales_date=p.business_date)
on conflict on constraint line_sales_manual_day_store_date_uidx do nothing;
