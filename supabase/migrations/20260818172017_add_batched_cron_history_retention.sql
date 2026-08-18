create or replace function public.cleanup_cron_job_run_history(
  p_retention interval default interval '30 days',
  p_batch_size integer default 10000
)
returns integer
language plpgsql
security definer
set search_path = 'public', 'cron'
as $$
declare
  v_deleted integer := 0;
begin
  with doomed as (
    select runid
    from cron.job_run_details
    where start_time < now() - p_retention
    order by runid
    limit greatest(1, least(coalesce(p_batch_size,10000),20000))
  )
  delete from cron.job_run_details d
  using doomed
  where d.runid = doomed.runid;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

do $$
begin
  if exists (select 1 from cron.job where jobname='cron-history-retention-job') then
    perform cron.unschedule('cron-history-retention-job');
  end if;
  perform cron.schedule(
    'cron-history-retention-job',
    '43 18 * * *',
    'select public.cleanup_cron_job_run_history(interval ''30 days'', 10000);'
  );
end $$;
