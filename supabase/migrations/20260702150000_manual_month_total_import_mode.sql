-- 日別売上管理表の「合計だけ入力」行を、日別レシートではなく月次手入力売上として取り込むための拡張。
-- 既存データは非破壊。税抜・消費税は入力がある場合だけ保存する。

alter table public.line_sales_manual_month_gross
  add column if not exists net_sales_yen bigint,
  add column if not exists tax_amount_yen bigint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'line_sales_manual_net_sales_yen_chk'
  ) then
    alter table public.line_sales_manual_month_gross
      add constraint line_sales_manual_net_sales_yen_chk
      check (net_sales_yen is null or net_sales_yen >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'line_sales_manual_tax_amount_yen_chk'
  ) then
    alter table public.line_sales_manual_month_gross
      add constraint line_sales_manual_tax_amount_yen_chk
      check (tax_amount_yen is null or tax_amount_yen >= 0);
  end if;
end;
$$;

alter table public.pending_daily_sales_imports
  add column if not exists import_mode text not null default 'daily',
  add column if not exists manual_month_entry jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pending_daily_sales_imports_import_mode_chk'
  ) then
    alter table public.pending_daily_sales_imports
      add constraint pending_daily_sales_imports_import_mode_chk
      check (import_mode in ('daily', 'manual_month'));
  end if;
end;
$$;
