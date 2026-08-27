-- A Supabase Auth JWT issued for M-talk must not become an administration JWT.
-- These routines are consumed by service-role Edge Functions, database cron,
-- or PostgreSQL triggers. None is a browser RPC.

revoke all on function public.ai_usage_model_totals(timestamptz, timestamptz)
  from public, anon, authenticated;
revoke all on function public.ai_usage_surface_model_totals(timestamptz, timestamptz, text, text)
  from public, anon, authenticated;
revoke all on function public.ai_usage_time_series(timestamptz, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.cleanup_cron_job_run_history(interval, integer)
  from public, anon, authenticated;
revoke all on function public.hide_cancelled_partner_reservation_events()
  from public, anon, authenticated;
revoke all on function public.invoke_high_frequency_dispatcher_cron()
  from public, anon, authenticated;
revoke all on function public.invoke_tokyo_dome_events_cron()
  from public, anon, authenticated;
revoke all on function public.invoke_weather_daily_cron()
  from public, anon, authenticated;
revoke all on function public.rebuild_partner_reservation_summary(text, text, text)
  from public, anon, authenticated;

grant execute on function public.ai_usage_model_totals(timestamptz, timestamptz)
  to service_role;
grant execute on function public.ai_usage_surface_model_totals(timestamptz, timestamptz, text, text)
  to service_role;
grant execute on function public.ai_usage_time_series(timestamptz, timestamptz, text)
  to service_role;
grant execute on function public.cleanup_cron_job_run_history(interval, integer)
  to postgres, service_role;
grant execute on function public.hide_cancelled_partner_reservation_events()
  to postgres, service_role;
grant execute on function public.invoke_high_frequency_dispatcher_cron()
  to postgres, service_role;
grant execute on function public.invoke_tokyo_dome_events_cron()
  to postgres, service_role;
grant execute on function public.invoke_weather_daily_cron()
  to postgres, service_role;
grant execute on function public.rebuild_partner_reservation_summary(text, text, text)
  to service_role;
