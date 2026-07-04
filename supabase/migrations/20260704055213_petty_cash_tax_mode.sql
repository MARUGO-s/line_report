alter table public.petty_cash_entries
  add column if not exists tax_mode text not null default 'ex';

alter table public.petty_cash_entries
  drop constraint if exists petty_cash_entries_tax_mode_check;

alter table public.petty_cash_entries
  add constraint petty_cash_entries_tax_mode_check
  check (tax_mode in ('ex', 'in'));

alter table public.petty_cash_pending
  add column if not exists tax_mode text;

alter table public.petty_cash_pending
  drop constraint if exists petty_cash_pending_tax_mode_check;

alter table public.petty_cash_pending
  add constraint petty_cash_pending_tax_mode_check
  check (tax_mode is null or tax_mode in ('ex', 'in'));
