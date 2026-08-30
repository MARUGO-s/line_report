-- 商品明細を日計総売上へ照合した月別coverage。
-- 月次インデックスが不一致日を除外していることをAPIから明示できるようにする。
create table if not exists public.journal_product_detail_coverage (
  store_partition_key text not null,
  year_month text not null
    check (year_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  status text not null
    check (status in ('complete', 'partial', 'incomplete')),
  policy text not null default 'receipt_and_item_totals_match_gross_sales'
    check (policy = 'receipt_and_item_totals_match_gross_sales'),
  scanned_days integer not null default 0 check (scanned_days >= 0),
  detail_complete_days integer not null default 0
    check (detail_complete_days >= 0),
  detail_incomplete_days integer not null default 0
    check (detail_incomplete_days >= 0),
  gross_mismatch_days integer not null default 0
    check (gross_mismatch_days >= 0),
  item_mismatch_days integer not null default 0
    check (item_mismatch_days >= 0),
  item_mismatch_receipts integer not null default 0
    check (item_mismatch_receipts >= 0),
  complete_gross_sales bigint not null default 0
    check (complete_gross_sales >= 0),
  excluded_gross_sales bigint not null default 0
    check (excluded_gross_sales >= 0),
  incomplete_dates date[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (store_partition_key, year_month),
  constraint journal_product_detail_coverage_day_count
    check (detail_complete_days + detail_incomplete_days = scanned_days),
  constraint journal_product_detail_coverage_reason_count
    check (
      gross_mismatch_days <= detail_incomplete_days
      and item_mismatch_days <= detail_incomplete_days
    )
);

comment on table public.journal_product_detail_coverage is
  'POS日計総売上と会計合計、各会計と商品合計が一致する日だけを商品・昼夜・cohort分析へ採用した月別coverage。';
comment on column public.journal_product_detail_coverage.excluded_gross_sales is
  '日計会計不一致または会計内商品不一致のため商品・時間帯・cohort明細から除外した総売上。日計売上自体を失った意味ではない。';
comment on column public.journal_product_detail_coverage.item_mismatch_days is
  '会計合計は日計と一致しても、会計内の商品金額合計が会計合計と一致せず明細分析から除外した営業日数。';

alter table public.journal_product_detail_coverage enable row level security;
revoke all on table public.journal_product_detail_coverage
  from public, anon, authenticated;
grant all on table public.journal_product_detail_coverage to service_role;

-- dirty世代は同一(store, month)内で必ず単調増加させる。乱数やtransactionの
-- now()一致に依存せず、rebuildと原本更新も同じadvisory lockで直列化する。
create or replace function public.touch_journal_product_index_dirty_month(
  p_store_partition_key text,
  p_year_month text
)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  stored_marker timestamptz;
begin
  if nullif(btrim(p_store_partition_key), '') is null then
    raise exception 'store_partition_key is required';
  end if;
  if p_year_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'year_month must be YYYY-MM';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'journal_product_index_snapshot:' || p_store_partition_key || ':' || p_year_month,
      0
    )
  );
  insert into public.journal_product_index_dirty_months (
    store_partition_key,
    year_month,
    touched_at
  ) values (
    p_store_partition_key,
    p_year_month,
    clock_timestamp()
  )
  on conflict (store_partition_key, year_month) do update set
    touched_at = greatest(
      clock_timestamp(),
      journal_product_index_dirty_months.touched_at + interval '1 microsecond'
    )
  returning touched_at into stored_marker;
  return stored_marker;
end;
$$;

revoke execute on function public.touch_journal_product_index_dirty_month(
  text, text
) from public, anon, authenticated;
grant execute on function public.touch_journal_product_index_dirty_month(
  text, text
) to service_role;

-- 既存pos_journal_files triggerも同じ単調marker/lock契約へ更新する。
create or replace function public.mark_journal_product_index_dirty_month()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_store text;
  target_month text;
begin
  if tg_op = 'DELETE' then
    target_store := old.store_partition_key;
    target_month := coalesce(
      nullif(btrim(old.year_month), ''),
      to_char(old.business_date, 'YYYY-MM')
    );
  else
    target_store := new.store_partition_key;
    target_month := coalesce(
      nullif(btrim(new.year_month), ''),
      to_char(new.business_date, 'YYYY-MM')
    );
  end if;

  if target_store is not null and target_month is not null then
    perform public.touch_journal_product_index_dirty_month(
      target_store,
      target_month
    );
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.mark_journal_product_index_dirty_month()
  from public, anon, authenticated;

-- snapshot生成中に同じ月の原本が更新された場合、古いsnapshotで新しいindexを
-- 上書きしない。marker確認からindex/coverage置換・dirty解除までを同一transaction
-- で行い、同月の複数rebuildはadvisory lockで直列化する。
create or replace function public.apply_journal_product_index_snapshot(
  p_store_partition_key text,
  p_year_month text,
  p_expected_touched_at timestamptz,
  p_index_rows jsonb,
  p_coverage jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_marker timestamptz;
  deleted_dirty_rows integer := 0;
begin
  if nullif(btrim(p_store_partition_key), '') is null then
    raise exception 'store_partition_key is required';
  end if;
  if p_year_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'year_month must be YYYY-MM';
  end if;
  if p_expected_touched_at is null then
    raise exception 'expected_touched_at is required';
  end if;
  if jsonb_typeof(coalesce(p_index_rows, 'null'::jsonb)) <> 'array' then
    raise exception 'index_rows must be a JSON array';
  end if;
  if jsonb_typeof(coalesce(p_coverage, 'null'::jsonb)) <> 'object' then
    raise exception 'coverage must be a JSON object';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'journal_product_index_snapshot:' || p_store_partition_key || ':' || p_year_month,
      0
    )
  );

  select dirty.touched_at
  into current_marker
  from public.journal_product_index_dirty_months as dirty
  where dirty.store_partition_key = p_store_partition_key
    and dirty.year_month = p_year_month
  for update;

  -- 後発upload/reparse/rebuildがmarkerを更新済み、またはdirty行が無い場合は
  -- snapshotを一切書かずfalseを返す。呼出側はdirty live fallbackを維持する。
  if current_marker is distinct from p_expected_touched_at then
    return false;
  end if;

  delete from public.journal_product_monthly_index
  where store_partition_key = p_store_partition_key
    and year_month = p_year_month;

  insert into public.journal_product_monthly_index (
    store_partition_key,
    year_month,
    product_name_norm,
    display_name,
    product_code,
    unit_price,
    qty,
    amount,
    day_count,
    first_date,
    last_date
  )
  select
    p_store_partition_key,
    p_year_month,
    row.product_name_norm,
    row.display_name,
    coalesce(row.product_code, ''),
    row.unit_price,
    row.qty,
    row.amount,
    row.day_count,
    row.first_date,
    row.last_date
  from jsonb_to_recordset(p_index_rows) as row(
    product_name_norm text,
    display_name text,
    product_code text,
    unit_price integer,
    qty integer,
    amount integer,
    day_count integer,
    first_date date,
    last_date date
  );

  insert into public.journal_product_detail_coverage (
    store_partition_key,
    year_month,
    status,
    policy,
    scanned_days,
    detail_complete_days,
    detail_incomplete_days,
    gross_mismatch_days,
    item_mismatch_days,
    item_mismatch_receipts,
    complete_gross_sales,
    excluded_gross_sales,
    incomplete_dates,
    updated_at
  ) values (
    p_store_partition_key,
    p_year_month,
    p_coverage->>'status',
    p_coverage->>'policy',
    (p_coverage->>'scanned_days')::integer,
    (p_coverage->>'detail_complete_days')::integer,
    (p_coverage->>'detail_incomplete_days')::integer,
    (p_coverage->>'gross_mismatch_days')::integer,
    (p_coverage->>'item_mismatch_days')::integer,
    (p_coverage->>'item_mismatch_receipts')::integer,
    (p_coverage->>'complete_gross_sales')::bigint,
    (p_coverage->>'excluded_gross_sales')::bigint,
    array(
      select value::date
      from jsonb_array_elements_text(
        coalesce(p_coverage->'incomplete_dates', '[]'::jsonb)
      ) as dates(value)
    ),
    now()
  )
  on conflict (store_partition_key, year_month) do update set
    status = excluded.status,
    policy = excluded.policy,
    scanned_days = excluded.scanned_days,
    detail_complete_days = excluded.detail_complete_days,
    detail_incomplete_days = excluded.detail_incomplete_days,
    gross_mismatch_days = excluded.gross_mismatch_days,
    item_mismatch_days = excluded.item_mismatch_days,
    item_mismatch_receipts = excluded.item_mismatch_receipts,
    complete_gross_sales = excluded.complete_gross_sales,
    excluded_gross_sales = excluded.excluded_gross_sales,
    incomplete_dates = excluded.incomplete_dates,
    updated_at = excluded.updated_at;

  delete from public.journal_product_index_dirty_months
  where store_partition_key = p_store_partition_key
    and year_month = p_year_month
    and touched_at = p_expected_touched_at;
  get diagnostics deleted_dirty_rows = row_count;
  if deleted_dirty_rows <> 1 then
    raise exception 'dirty marker changed while applying journal product snapshot';
  end if;
  return true;
end;
$$;

revoke execute on function public.apply_journal_product_index_snapshot(
  text, text, timestamptz, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.apply_journal_product_index_snapshot(
  text, text, timestamptz, jsonb, jsonb
) to service_role;

comment on function public.apply_journal_product_index_snapshot(
  text, text, timestamptz, jsonb, jsonb
) is 'service_role専用。dirty世代が一致するPOS商品index snapshotだけを原子的に適用する。';

-- 旧インデックスは日計照合前のparsed_dataから作られており、確定商品明細として
-- 再利用できない。正本pos_journal_filesと旧derived rowsはロールバック用に保持し、
-- 全店舗・全月をdirty化する。再構築完了まではadmin-apiがsafe live scanを使う。
insert into public.journal_product_index_dirty_months (
  store_partition_key,
  year_month,
  touched_at
)
select distinct
  store_partition_key,
  coalesce(nullif(btrim(year_month), ''), to_char(business_date, 'YYYY-MM')),
  now()
from public.pos_journal_files
where storage_deleted_at is null
  and parsed_data is not null
  and coalesce(nullif(btrim(year_month), ''), to_char(business_date, 'YYYY-MM'))
    ~ '^\d{4}-(0[1-9]|1[0-2])$'
on conflict (store_partition_key, year_month) do update
set touched_at = excluded.touched_at;
