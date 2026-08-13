-- 評価セットの作成元runを削除・参照する際の外部キー検索を保護する。
create index if not exists idx_foodcourt_prompt_evaluation_cases_source_run
  on public.foodcourt_prompt_evaluation_cases (source_run_id);
