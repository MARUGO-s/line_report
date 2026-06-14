-- パフォーマンス強化: RLS ポリシー内の auth.*() を (select auth.*()) で包み、行ごと再評価を回避する。
--
-- 背景: Supabase Performance Advisor の WARN `auth_rls_initplan`。
--   ポリシー式中で auth.jwt() / auth.role() 等を直接呼ぶと、RLS が行ごとに関数を再評価し、
--   テーブルが大きくなるほど遅くなる。(select auth.xxx()) で包むと InitPlan として一度だけ評価され、
--   結果は完全に同一（意味は変わらない）。これは Supabase 公式が推奨する定石。
--
-- 対象（事前確認済み・全51ポリシー＝3定型のみ。auth.uid() を使うユーザー向けポリシーは存在しない）:
--   ・46件: USING ((auth.jwt() ->> 'role') = 'service_role')                    （with_check なし）
--   ・ 4件: 上記 + 同一 with_check（admin_dashboard_auth_tokens / line_room_dismissed /
--           line_room_names / line_user_permissions）
--   ・ 1件: USING (auth.role() = 'service_role') + 同一 with_check（receipt_sheets_sync_status）
--   いずれも cmd=ALL / roles={public} で「service_role のみ許可」。アクセス可否は不変。
--
-- ALTER POLICY で各ポリシーを破棄せず式だけ差し替える（権限・ロール・コマンドは保持）。
-- 既に (select auth.…) で包まれているものはスキップ＝冪等。

do $$
declare
  r record;
  new_qual text;
  new_wc   text;
begin
  for r in
    select
      n.nspname               as sch,
      c.relname               as tbl,
      pol.polname             as pol,
      pg_get_expr(pol.polqual,      pol.polrelid) as qual,
      pg_get_expr(pol.polwithcheck, pol.polrelid) as wc
    from pg_policy pol
    join pg_class      c on c.oid = pol.polrelid
    join pg_namespace  n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and (
        pg_get_expr(pol.polqual,      pol.polrelid) ~ 'auth\.(uid|role|jwt|email)\(\)'
        or pg_get_expr(pol.polwithcheck, pol.polrelid) ~ 'auth\.(uid|role|jwt|email)\(\)'
      )
      -- 既に (select auth.…) で包まれているポリシーは対象外（冪等性）
      and not (
        coalesce(pg_get_expr(pol.polqual,      pol.polrelid), '') ~* '\(\s*select\s+auth\.'
        or coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~* '\(\s*select\s+auth\.'
      )
  loop
    new_qual := regexp_replace(r.qual, 'auth\.(uid|role|jwt|email)\(\)', '(select auth.\1())', 'g');

    if r.wc is null then
      execute format('alter policy %I on %I.%I using (%s)',
                     r.pol, r.sch, r.tbl, new_qual);
    else
      new_wc := regexp_replace(r.wc, 'auth\.(uid|role|jwt|email)\(\)', '(select auth.\1())', 'g');
      execute format('alter policy %I on %I.%I using (%s) with check (%s)',
                     r.pol, r.sch, r.tbl, new_qual, new_wc);
    end if;

    raise notice 'rls auth-initplan optimized: %.%  (%)', r.sch, r.tbl, r.pol;
  end loop;
end $$;
