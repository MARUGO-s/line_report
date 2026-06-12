-- セキュリティ修正(CRITICAL): 公開anonキーで実行できる SECURITY DEFINER 関数が RLS を全面バイパスし、
-- 匿名での 全LINEメッセージ流出 / 全削除(purge_line_room_messages_older_than) / 偽売上・予約の注入 /
-- cron認証トークン読取(resolve_edge_cron_auth_token) / 任意cron起動(invoke_*_cron) を許していた。
--
-- フロント(静的ページ)はこれらRPCを直接呼ばず全てEdge Function経由、Edge Functionは全て
-- SUPABASE_SERVICE_ROLE_KEY で接続するため、anon/authenticated/public からEXECUTEを剥奪しても
-- アプリ動作には影響しない(service_role は明示GRANTを維持)。可逆(再GRANT可)。
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and (has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;
