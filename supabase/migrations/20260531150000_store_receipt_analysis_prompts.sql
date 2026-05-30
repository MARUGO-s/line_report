-- 店舗別のレシート解析プロンプト（任意・追記方式）。
-- 既定のシステムプロンプト（コード側で常に保持）に、ここに保存した店舗固有の補足を連結して解析する。
-- 未設定／enabled=false の店舗は既定プロンプトのまま（＝挙動不変）。
-- 特殊フォーマット店（例: バルぺロタ＝精算/レジ締め形式）の項目対応を、コード変更なしで運用調整できる。

create table if not exists public.store_receipt_analysis_prompts (
  store_partition_key text primary key,
  prompt text not null default '',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.store_receipt_analysis_prompts enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'store_receipt_analysis_prompts'
      and policyname = 'Service role can do everything on store_receipt_analysis_prompts'
  ) then
    create policy "Service role can do everything on store_receipt_analysis_prompts"
      on public.store_receipt_analysis_prompts
      for all
      using (auth.jwt() ->> 'role' = 'service_role');
  end if;
end;
$$;

comment on table public.store_receipt_analysis_prompts
  is '店舗別レシート解析プロンプト（既定プロンプトへ追記する補足。未設定店は既定のまま）。';
