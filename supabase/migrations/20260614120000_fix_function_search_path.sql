-- セキュリティ強化: search_path 未固定の関数に固定 search_path を設定する。
--
-- 背景: Supabase Security Advisor の WARN `function_search_path_mutable`。
--   search_path が呼び出し側に依存する関数は、特に SECURITY DEFINER（所有者=高権限で実行）
--   の場合に「悪意あるスキーマを先頭に差し込んで関数の参照を乗っ取る」権限昇格の経路になりうる。
--
-- 安全性の根拠（このリポジトリで事前確認済み）:
--   ・対象関数が参照する拡張/特殊スキーマ（net.http_post / cron.job / vault.decrypted_secrets）は
--     すべてスキーマ修飾済み。無修飾参照は public のオブジェクトのみ。
--   ・本プロジェクトは PostgreSQL 17 で、public スキーマへの CREATE はデフォルトで PUBLIC から剥奪済み
--     （anon/authenticated は public にオブジェクトを作れない）。
--   よって search_path を `public` に固定しても cron 等は停止せず、かつ乗っ取り経路を塞げる。
--   （pg_catalog は常に暗黙で先頭探索されるため built-in は解決される。pg_temp は意図的に含めない。）
--
-- DO ブロックでオーバーロード（invoke_summary_cron の2シグネチャ）も含め名前一致で一括適用。冪等。

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        -- SECURITY DEFINER（最優先）
        'check_cron_history','check_cron_jobs','check_cron_settings','check_profiles_exists',
        'cleanup_security_rate_limits','consume_security_rate_limit',
        'invoke_calendar_pending_cron','invoke_gmail_alert_cron','invoke_receipt_midreport_cron',
        'invoke_receipt_sheets_sync_cron','invoke_reservation_today_cron','invoke_summary_cron',
        'list_all_tables','list_public_tables','resolve_edge_cron_auth_token','try_select_profiles',
        -- 非 SECURITY DEFINER のヘルパー（警告解消のため同様に固定）
        'escape_like_pattern_fragment','is_line_search_control_text','is_valid_line_room_id',
        'is_valid_store_partition_key','line_room_message_table_name',
        'reservation_visit_looks_cancelled','reservation_visit_looks_modified',
        'store_receipt_table_name','store_webhook_raw_table_name'
      )
  loop
    execute format('alter function %s set search_path = public', r.sig);
    raise notice 'search_path pinned: %', r.sig;
  end loop;
end $$;
