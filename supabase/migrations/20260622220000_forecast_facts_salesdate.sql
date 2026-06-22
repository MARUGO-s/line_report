-- テナント一覧は「翌朝に出る“前日”の売上比較表」。report_date はレポート発行日なので、
-- 実際の売上日は前日(-1)。foodcourt_daily_facts.business_date を売上日へ揃える
-- （ページ/AI/相関も同様に -1 シフト済み）。CREATE OR REPLACE で関数のみ更新し再バックフィル。
create or replace function public.sync_foodcourt_daily_facts()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  bdate date;
  base  text;
begin
  if tg_op = 'DELETE' then
    delete from public.foodcourt_daily_facts where source_report_id = old.id;
    return old;
  end if;
  bdate := coalesce(new.report_date, (new.created_at at time zone 'Asia/Tokyo')::date) - 1;  -- 売上日=発行日の前日
  base  := coalesce(new.base_tenant_name, 'MARUGO S');
  delete from public.foodcourt_daily_facts where source_report_id = new.id;
  insert into public.foodcourt_daily_facts
    (business_date, source_store_key, tenant_code, tenant_name, sales, guests, avg_spend, comp_sales, comp_guests, is_base, source_report_id)
  select
    bdate,
    new.store_partition_key,
    nullif(t->>'code', ''),
    t->>'name',
    nullif(regexp_replace(coalesce(t->>'sales', ''),  '[^0-9-]', '', 'g'), '')::bigint,
    nullif(regexp_replace(coalesce(t->>'guests', ''), '[^0-9-]', '', 'g'), '')::int,
    case when nullif(regexp_replace(coalesce(t->>'guests', ''), '[^0-9]', '', 'g'), '')::numeric > 0
         then round( nullif(regexp_replace(coalesce(t->>'sales', ''),  '[^0-9-]', '', 'g'), '')::numeric
                   / nullif(regexp_replace(coalesce(t->>'guests', ''), '[^0-9]',  '', 'g'), '')::numeric )
         else null end,
    nullif(regexp_replace(coalesce(t->>'compSales', ''),  '[^0-9-]', '', 'g'), '')::bigint,
    nullif(regexp_replace(coalesce(t->>'compGuests', ''), '[^0-9-]', '', 'g'), '')::int,
    (lower(regexp_replace(coalesce(t->>'name', ''), '\s', '', 'g')) = lower(regexp_replace(base, '\s', '', 'g'))),
    new.id
  from jsonb_array_elements(new.tenants) t
  where coalesce(t->>'name', '') <> ''
  on conflict (business_date, tenant_name) do update set
    source_store_key = excluded.source_store_key,
    tenant_code      = excluded.tenant_code,
    sales            = excluded.sales,
    guests           = excluded.guests,
    avg_spend        = excluded.avg_spend,
    comp_sales       = excluded.comp_sales,
    comp_guests      = excluded.comp_guests,
    is_base          = excluded.is_base,
    source_report_id = excluded.source_report_id,
    updated_at       = now();
  return new;
end $fn$;

-- 既存 facts を売上日へ作り直し（trigger 再発火）
update public.foodcourt_tenant_reports set base_tenant_name = base_tenant_name;
