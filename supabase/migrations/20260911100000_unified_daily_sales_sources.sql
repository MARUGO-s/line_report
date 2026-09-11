-- Preserve the source facts independently from the published daily values.
-- Existing business amounts, receipt originals and store sync settings are unchanged.
alter table public.line_sales_manual_day
  add column if not exists journal_values jsonb,
  add column if not exists manual_values jsonb not null default '{}'::jsonb;

update public.line_sales_manual_day
set journal_values = jsonb_strip_nulls(jsonb_build_object(
  'gross_sales_yen', gross_sales_yen, 'tax_amount_yen', tax_amount_yen,
  'guest_count', guest_count, 'party_count', party_count))
where source = 'journal' and journal_values is null;

update public.line_sales_manual_day
set manual_values = jsonb_strip_nulls(jsonb_build_object(
  'gross_sales_yen', gross_sales_yen, 'tax_amount_yen', tax_amount_yen,
  'guest_count', guest_count, 'party_count', party_count))
where source is distinct from 'journal' and manual_values = '{}'::jsonb;

comment on column public.line_sales_manual_day.journal_values is
  'Latest synced journal daily facts, retained under manual corrections. Never add to receipt totals.';
comment on column public.line_sales_manual_day.manual_values is
  'Explicit per-field overrides. Removing a key restores journal then receipt. Journal sync never replaces these keys.';

create or replace function public.write_daily_sales_source(p_store_key text, p_kind text, p_rows jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_store text;
  v_row jsonb;
  v_field text;
  v_date date;
  v_old public.line_sales_manual_day%rowtype;
  v_journal jsonb;
  v_manual jsonb;
  v_gross bigint;
  v_tax bigint;
  v_guests bigint;
  v_party bigint;
  v_applied integer := 0;
begin
  if p_kind not in ('journal', 'manual') or p_kind is null or
     jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 3660 then
    raise exception 'Invalid daily sales source request' using errcode = '22023';
  end if;
  select store_partition_key into strict v_store from public.store_webhook_tables
    where lower(store_partition_key) = lower(trim(p_store_key));
  -- Serialize patches and sync for this store, including first insertion of a date.
  perform pg_advisory_xact_lock(hashtextextended('daily-sales:' || v_store, 0));
  for v_row in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_row) is distinct from 'object' or
       coalesce(v_row->>'sales_date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'Invalid sales date' using errcode = '22023';
    end if;
    v_date := (v_row->>'sales_date')::date;
    foreach v_field in array array['gross_sales_yen','tax_amount_yen','guest_count','party_count'] loop
      if p_kind = 'journal' and (not v_row ? v_field or v_row->v_field = 'null'::jsonb) then
        raise exception 'Incomplete journal daily totals' using errcode = '22023';
      end if;
      if v_row ? v_field and v_row->v_field <> 'null'::jsonb and (
        jsonb_typeof(v_row->v_field) <> 'number' or
        (v_row->>v_field)::numeric < 0 or (v_row->>v_field)::numeric > 9007199254740991 or
        trunc((v_row->>v_field)::numeric) <> (v_row->>v_field)::numeric) then
        raise exception 'Invalid daily sales amount' using errcode = '22023';
      end if;
    end loop;
    select * into v_old from public.line_sales_manual_day
      where store_partition_key = v_store and sales_date = v_date for update;
    v_journal := v_old.journal_values;
    v_manual := coalesce(v_old.manual_values, '{}'::jsonb);
    if p_kind = 'journal' then
      v_journal := jsonb_build_object('gross_sales_yen', v_row->'gross_sales_yen',
        'tax_amount_yen', v_row->'tax_amount_yen', 'guest_count', v_row->'guest_count',
        'party_count', v_row->'party_count');
      if (v_journal->>'tax_amount_yen')::bigint > (v_journal->>'gross_sales_yen')::bigint then
        raise exception 'Journal tax exceeds gross' using errcode = '22023';
      end if;
    else
      foreach v_field in array array['gross_sales_yen','tax_amount_yen','guest_count','party_count'] loop
        if v_row ? v_field then
          v_manual := case when v_row->v_field = 'null'::jsonb then v_manual - v_field
            else jsonb_set(v_manual, array[v_field], v_row->v_field) end;
        end if;
      end loop;
    end if;
    v_gross := coalesce((v_manual->>'gross_sales_yen')::bigint, (v_journal->>'gross_sales_yen')::bigint);
    v_tax := coalesce((v_manual->>'tax_amount_yen')::bigint, (v_journal->>'tax_amount_yen')::bigint);
    v_guests := coalesce((v_manual->>'guest_count')::bigint, (v_journal->>'guest_count')::bigint);
    v_party := coalesce((v_manual->>'party_count')::bigint, (v_journal->>'party_count')::bigint);
    if p_kind = 'manual' and v_tax > v_gross then
      raise exception 'Tax exceeds corrected gross; correct tax as well' using errcode = '22023';
    end if;
    if v_journal is null and v_manual = '{}'::jsonb then
      delete from public.line_sales_manual_day where store_partition_key = v_store and sales_date = v_date;
    else
      insert into public.line_sales_manual_day as target
        (store_partition_key, sales_date, gross_sales_yen, tax_amount_yen, guest_count, party_count,
         journal_values, manual_values, source, updated_at)
      values (v_store, v_date, v_gross, v_tax, v_guests, v_party, v_journal, v_manual,
        case when v_manual <> '{}'::jsonb then 'manual' else 'journal' end, now())
      on conflict on constraint line_sales_manual_day_store_date_uidx do update set
        gross_sales_yen = excluded.gross_sales_yen, tax_amount_yen = excluded.tax_amount_yen,
        guest_count = excluded.guest_count, party_count = excluded.party_count,
        journal_values = excluded.journal_values, manual_values = excluded.manual_values,
        source = excluded.source, updated_at = excluded.updated_at
      where (target.gross_sales_yen, target.tax_amount_yen, target.guest_count, target.party_count,
        target.journal_values, target.manual_values, target.source) is distinct from
        (excluded.gross_sales_yen, excluded.tax_amount_yen, excluded.guest_count, excluded.party_count,
        excluded.journal_values, excluded.manual_values, excluded.source);
    end if;
    v_applied := v_applied + 1;
  end loop;
  return jsonb_build_object('applied', v_applied);
end;
$$;
revoke all on function public.write_daily_sales_source(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.write_daily_sales_source(text,text,jsonb) to service_role;

-- Keep the forecast's existing columns/security; adopt the same effective daily facts.
create or replace view public.foodcourt_base_daily with (security_invoker = true) as
with rcpt as (
  select receipt_date as d, sum(guest_count)::bigint as guests,
    sum(net_sales_yen)::bigint as net_sales, sum(tax_amount_yen)::bigint as tax,
    sum(gross_sales_yen)::bigint as gross_sales, sum(party_count)::bigint as party
  from public."line_receipt__marugoS" where receipt_date is not null group by receipt_date
), man as (
  select * from public.line_sales_manual_day where store_partition_key = 'marugoS'
)
select dd.d as business_date,
  coalesce(man.guest_count, rcpt.guests) as guests,
  case when man.gross_sales_yen is not null then
    case when coalesce(man.tax_amount_yen,rcpt.tax) is null then null::bigint
    else greatest(0::bigint, man.gross_sales_yen - coalesce(man.tax_amount_yen, rcpt.tax)) end
    when man.tax_amount_yen is not null then greatest(0::bigint, rcpt.gross_sales - man.tax_amount_yen)
    else rcpt.net_sales end as sales,
  coalesce(man.gross_sales_yen, rcpt.gross_sales) as sales_gross,
  coalesce(man.party_count, rcpt.party) as party,
  (man.gross_sales_yen is not null or man.guest_count is not null or man.party_count is not null) as has_manual
from (select d from rcpt union select sales_date from man) dd
left join rcpt on rcpt.d = dd.d left join man on man.sales_date = dd.d;
revoke all on public.foodcourt_base_daily from public, anon, authenticated;
grant select on public.foodcourt_base_daily to service_role;
