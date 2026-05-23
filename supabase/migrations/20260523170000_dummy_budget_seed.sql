-- 全店舗 line_sales_month_budgets 向けダミー予算（テスト用）
-- 識別: store_closed_dates->>'_seed_tag' = 'line_report_dummy_budget_v1'
-- 一括削除: select * from public.delete_dummy_store_budgets();

create or replace function public.delete_dummy_store_budgets(
  p_seed_tag text default 'line_report_dummy_budget_v1'
)
returns table(
  store_partition_key text,
  deleted_budget_rows bigint,
  deleted_closed_day_rows bigint
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  rec record;
  budget_cnt bigint;
  closed_cnt bigint;
begin
  for rec in
    select sw.store_partition_key
    from public.store_webhook_tables sw
    order by sw.store_partition_key
  loop
    delete from public.line_sales_month_store_closed_days cd
    where cd.store_partition_key = rec.store_partition_key
      and cd.target_month in (
        select b.target_month
        from public.line_sales_month_budgets b
        where b.store_partition_key = rec.store_partition_key
          and coalesce(b.store_closed_dates->>'_seed_tag', '') = p_seed_tag
      );
    get diagnostics closed_cnt = row_count;

    delete from public.line_sales_month_budgets b
    where b.store_partition_key = rec.store_partition_key
      and coalesce(b.store_closed_dates->>'_seed_tag', '') = p_seed_tag;
    get diagnostics budget_cnt = row_count;

    store_partition_key := rec.store_partition_key;
    deleted_budget_rows := budget_cnt;
    deleted_closed_day_rows := closed_cnt;
    return next;
  end loop;
end;
$$;

comment on function public.delete_dummy_store_budgets(text) is
  'ダミー予算（store_closed_dates._seed_tag 一致）と関連店舗休日を全店舗分一括削除する。';

create or replace function public.seed_dummy_store_budgets(
  p_seed_tag text default 'line_report_dummy_budget_v1',
  p_years_back integer default 3
)
returns table(
  store_partition_key text,
  inserted_budget_rows bigint,
  inserted_closed_day_rows bigint
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  rec record;
  m date;
  start_month date;
  end_month date;
  ym text;
  seed_int int;
  budget_yen bigint;
  ww numeric(14, 4);
  pw numeric(14, 4);
  hw numeric(14, 4);
  closed_json jsonb;
  budget_total bigint;
  closed_total bigint;
  closed_day date;
  d int;
begin
  if p_years_back < 1 or p_years_back > 10 then
    raise exception 'p_years_back must be between 1 and 10 (got %)', p_years_back;
  end if;

  end_month := date_trunc('month', (timezone('Asia/Tokyo', now()))::date)::date;
  start_month := (end_month - make_interval(years => p_years_back))::date;
  start_month := date_trunc('month', start_month)::date;

  perform public.delete_dummy_store_budgets(p_seed_tag);

  for rec in
    select sw.store_partition_key
    from public.store_webhook_tables sw
    order by sw.store_partition_key
  loop
    budget_total := 0;
    closed_total := 0;
    m := start_month;

    while m <= end_month loop
      ym := to_char(m, 'YYYY-MM');
      seed_int := abs(hashtext(rec.store_partition_key || ym || p_seed_tag));

      -- 月間予算: 180万〜850万（店舗・月でばらつき、繁忙期は上振れ）
      budget_yen := 1800000 + (seed_int % 6700000);
      if extract(month from m)::int in (12, 1, 3, 5) then
        budget_yen := budget_yen + (seed_int % 1200000);
      end if;

      ww := 1.0 + ((seed_int % 15)::numeric / 100);
      pw := 1.5 + ((seed_int % 20)::numeric / 100);
      hw := 2.0 + ((seed_int % 25)::numeric / 100);

      closed_json := jsonb_build_object('_seed_tag', p_seed_tag, 'dummy', true);

      insert into public.line_sales_month_budgets (
        store_partition_key,
        target_month,
        budget_yen,
        weekday_weight,
        pre_holiday_weight,
        holiday_weight,
        store_closed_dates,
        updated_at
      ) values (
        rec.store_partition_key,
        ym,
        budget_yen,
        ww,
        pw,
        hw,
        closed_json,
        now()
      )
      on conflict (store_partition_key, target_month) do update
      set
        budget_yen = excluded.budget_yen,
        weekday_weight = excluded.weekday_weight,
        pre_holiday_weight = excluded.pre_holiday_weight,
        holiday_weight = excluded.holiday_weight,
        store_closed_dates = excluded.store_closed_dates,
        updated_at = excluded.updated_at;

      budget_total := budget_total + 1;

      -- 月1〜2日の店舗休日（ダミー）
      for d in 1..(1 + (seed_int % 2)) loop
        closed_day := m + ((seed_int + d * 7) % 28);
        if extract(month from closed_day)::int = extract(month from m)::int then
          insert into public.line_sales_month_store_closed_days (
            store_partition_key,
            target_month,
            closed_on
          ) values (
            rec.store_partition_key,
            ym,
            closed_day
          )
          on conflict (store_partition_key, target_month, closed_on) do nothing;
          closed_total := closed_total + 1;
        end if;
      end loop;

      m := (m + interval '1 month')::date;
    end loop;

    store_partition_key := rec.store_partition_key;
    inserted_budget_rows := budget_total;
    inserted_closed_day_rows := closed_total;
    return next;
  end loop;
end;
$$;

comment on function public.seed_dummy_store_budgets(text, integer) is
  '全店舗に過去 p_years_back 年分〜今月（JST）までのダミー月間予算を投入する。再実行時は既存ダミーを置き換える。';
