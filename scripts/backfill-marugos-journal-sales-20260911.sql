-- Authorized one-time repair: MARUGO S only. No schema changes or raw data.
-- Before running: privately back up its profile/day/month rows; deploy the
-- compact-report + profile-key fix. Keep all original journals and receipts.
-- One transaction. Re-running with unchanged input does not change row counts/values.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
declare
  source_count integer;
  unique_count integer;
begin
  perform 1 from public.store_operation_profiles
    where store_partition_key = 'marugos' for update;
  if not found then raise exception 'MARUGO S journal profile missing'; end if;
  if exists(select 1 from public.store_operation_profiles
    where lower(store_partition_key) = 'marugos' and store_partition_key <> 'marugos') then
    raise exception 'Unexpected profile alias';
  end if;
  if exists(select 1 from public.line_sales_manual_day
    where lower(store_partition_key) = 'marugos' and store_partition_key <> 'marugoS') then
    raise exception 'Unexpected daily sales alias';
  end if;
  if exists(select 1 from public.line_sales_manual_month_gross
    where lower(store_partition_key) = 'marugos' and store_partition_key <> 'marugoS') then
    raise exception 'Unexpected monthly sales alias';
  end if;

  -- Lock the exact source range during validation and writing.
  perform 1 from public.pos_journal_files
    where store_partition_key = 'marugos'
      and business_date between '2025-12-09' and '2026-08-25' for share;
  select count(*), count(distinct business_date) into source_count, unique_count
    from public.pos_journal_files where store_partition_key = 'marugos'
      and business_date between '2025-12-09' and '2026-08-25';
  if source_count <> 260 or unique_count <> 260 then
    raise exception 'Source coverage changed; review before retrying';
  end if;
  if exists(select 1 from public.pos_journal_files
    where store_partition_key = 'marugos'
      and business_date between '2025-12-09' and '2026-08-25'
      and (gross_sales is null or tax_yen is null or guests_count is null or groups_count is null
        or gross_sales < 0 or tax_yen < 0 or tax_yen > gross_sales
        or guests_count < 0 or groups_count < 0
        or year_month <> to_char(business_date, 'YYYY-MM'))) then
    raise exception 'Invalid source totals';
  end if;
  -- Every source must have an identical saved-report day; do not add the two copies.
  if exists(select 1 from public.pos_journal_files p
    where p.store_partition_key = 'marugos'
      and p.business_date between '2025-12-09' and '2026-08-25'
      and not exists(select 1 from public.saved_reports r
        cross join lateral jsonb_array_elements(coalesce(r.data->'posJournalDays', '[]'::jsonb)) d
        where r.store_partition_key = 'marugos' and r.deleted_at is null
          and d->>'business_date' = p.business_date::text
          and (d->>'gross_sales')::bigint = p.gross_sales
          and (d->>'tax')::bigint = p.tax_yen
          and (d->>'guests')::bigint = p.guests_count
          and (d->>'groups')::bigint = p.groups_count)) then
    raise exception 'Journal source and saved report do not agree';
  end if;
  -- Preflight found no daily overrides. A newly entered manual value needs review.
  perform 1 from public.line_sales_manual_day
    where store_partition_key = 'marugoS'
      and sales_date between '2025-12-09' and '2026-08-25' for update;
  if exists(select 1 from public.line_sales_manual_day
    where store_partition_key = 'marugoS'
      and sales_date between '2025-12-09' and '2026-08-25'
      and source is distinct from 'journal') then
    raise exception 'New non-journal daily override requires review';
  end if;
  perform 1 from public.line_sales_manual_month_gross
    where store_partition_key = 'marugoS'
      and sales_month between '2025-12' and '2026-08' for update;

  update public.store_operation_profiles
    set profile = jsonb_set(profile, '{journalSalesSync}', 'true'::jsonb), updated_at = now()
    where store_partition_key = 'marugos'
      and profile->'journalSalesSync' is distinct from 'true'::jsonb;

  insert into public.line_sales_manual_day as target
    (store_partition_key, sales_date, gross_sales_yen, tax_amount_yen, guest_count, party_count, source)
    select 'marugoS', business_date, gross_sales, tax_yen, guests_count, groups_count, 'journal'
    from public.pos_journal_files where store_partition_key = 'marugos'
      and business_date between '2025-12-09' and '2026-08-25'
    on conflict (store_partition_key, sales_date) do update set
      gross_sales_yen = excluded.gross_sales_yen, tax_amount_yen = excluded.tax_amount_yen,
      guest_count = excluded.guest_count, party_count = excluded.party_count,
      source = excluded.source, updated_at = now()
    where (target.gross_sales_yen, target.tax_amount_yen, target.guest_count, target.party_count, target.source)
      is distinct from (excluded.gross_sales_yen, excluded.tax_amount_yen, excluded.guest_count, excluded.party_count, excluded.source);

  -- Rebuild from ALL daily overrides in each affected month, not just this batch.
  insert into public.line_sales_manual_month_gross as target
    (store_partition_key, sales_month, gross_sales_yen, net_sales_yen, tax_amount_yen,
      guest_count, party_count, operating_days_count, source)
    select 'marugoS', to_char(sales_date, 'YYYY-MM'), sum(gross_sales_yen),
      sum(gross_sales_yen) - sum(coalesce(tax_amount_yen, 0)), sum(coalesce(tax_amount_yen, 0)),
      sum(coalesce(guest_count, 0)), sum(coalesce(party_count, 0)), count(*) filter(where gross_sales_yen > 0),
      case when count(distinct nullif(source, '')) > 1 then 'mixed'
        else coalesce(min(nullif(source, '')), 'journal') end
    from public.line_sales_manual_day
    where store_partition_key = 'marugoS' and sales_date >= '2025-12-01' and sales_date < '2026-09-01'
    group by to_char(sales_date, 'YYYY-MM')
    on conflict (store_partition_key, sales_month) do update set
      gross_sales_yen = excluded.gross_sales_yen, net_sales_yen = excluded.net_sales_yen,
      tax_amount_yen = excluded.tax_amount_yen, guest_count = excluded.guest_count,
      party_count = excluded.party_count, operating_days_count = excluded.operating_days_count,
      source = excluded.source, updated_at = now()
    where (target.gross_sales_yen, target.net_sales_yen, target.tax_amount_yen, target.guest_count,
      target.party_count, target.operating_days_count, target.source) is distinct from
      (excluded.gross_sales_yen, excluded.net_sales_yen, excluded.tax_amount_yen, excluded.guest_count,
      excluded.party_count, excluded.operating_days_count, excluded.source);
end $$;
commit;

-- No business amounts are printed.
select (select profile->'journalSalesSync' from public.store_operation_profiles
    where store_partition_key = 'marugos') as sync_enabled,
  (select count(*) from public.line_sales_manual_day where store_partition_key = 'marugoS'
    and sales_date between '2025-12-09' and '2026-08-25' and source = 'journal') as synced_days,
  (select count(*) from public.line_sales_manual_month_gross where store_partition_key = 'marugoS'
    and sales_month between '2025-12' and '2026-08') as synced_months;
