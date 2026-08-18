-- トリガ関数が PostgREST の RPC として外部から呼べる状態だったため権限を剥奪する。
-- （Supabase セキュリティアドバイザ anon/authenticated_security_definer_function_executable）
--
-- トリガの発火は関数の EXECUTE 権限を見ないため、剥奪しても動作に影響はない。
-- 検証: user_id / username を送らずに INSERT しても、トリガが両方を確定させることを確認済み。
revoke all on function public.chat_enforce_allowed_email() from public, anon, authenticated;
revoke all on function public.chat_set_message_author() from public, anon, authenticated;
revoke all on function public.chat_set_group_owner() from public, anon, authenticated;
