-- Close the remaining advisor-visible execution and view boundaries without
-- changing backend behavior. The forecast worker uses service_role, and the
-- two helper functions are called only by backend/cron-owned SQL paths.

alter view public.foodcourt_daily_features
  set (security_invoker = true);

revoke all privileges on table public.foodcourt_daily_features
  from public, anon, authenticated;
grant select on table public.foodcourt_daily_features
  to service_role;

alter function public.reservation_visit_extract_reservation_no(text)
  set search_path = pg_catalog;
revoke execute on function public.reservation_visit_extract_reservation_no(text)
  from public, anon, authenticated;
grant execute on function public.reservation_visit_extract_reservation_no(text)
  to postgres, service_role;

alter function public.invoke_pv_japan_alert_cron()
  set search_path = pg_catalog;
revoke execute on function public.invoke_pv_japan_alert_cron()
  from public, anon, authenticated;
grant execute on function public.invoke_pv_japan_alert_cron()
  to postgres, service_role;
