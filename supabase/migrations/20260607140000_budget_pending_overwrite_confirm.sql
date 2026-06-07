-- 予算登録フロー: 既存予算/過去売上があるときの「上書き保存／キャンセル」確認ステップ用。
-- 確認待ちの間、入力済みの予算額を保持する列を追加し、step に await_overwrite_confirm を許可する。
alter table public.store_budget_entry_pending
  add column if not exists budget_yen bigint;

alter table public.store_budget_entry_pending
  drop constraint if exists store_budget_entry_pending_step_chk;

alter table public.store_budget_entry_pending
  add constraint store_budget_entry_pending_step_chk
  check (step in ('await_month', 'await_amount', 'await_overwrite_confirm'));
