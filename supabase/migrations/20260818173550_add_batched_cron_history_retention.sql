create or replace function public.cleanup_cron_job_run_details_batch(
  p_retention interval default interval '30 days',
  p_limit integer default 10000
)
returns integer
language plpgsql
security definer
set search_path = 'cron', 'pg_catalog'
as $$
declare
  v_deleted integer := 0;
  v_limit integer := greatest(1, least(coalesce(p_limit, 10000), 10000));
begin
  with doomed as (
    select runid
    from cron.job_run_details
    where start_time < now() - p_retention
    order by start_time asc
    limit v_limit
  )
  delete from cron.job_run_details d
  using doomed
  where d.runid = doomed.runid;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.cleanup_cron_job_run_details_batch(interval, integer) from public, anon, authenticated;
grant execute on function public.cleanup_cron_job_run_details_batch(interval, integer) to postgres;

do $$
begin
  perform cron.unschedule('cron-job-history-retention');
exception when others then
  null;
end $$;

select cron.schedule(
  'cron-job-history-retention',
  '43 18 * * *',
  $cron$select public.cleanup_cron_job_run_details_batch(interval '30 days', 10000);$cron$
);
