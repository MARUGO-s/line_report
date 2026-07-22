-- Data APIの既定権限も明示的に除去し、admin-api(service_role)だけに限定する。
revoke all on table public.foodcourt_ai_fallback_events from anon, authenticated;
