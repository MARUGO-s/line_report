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
  v_keep_last bigint := 60000;
  v_cutoff_runid bigint;
begin
  select max(runid) - v_keep_last
    into v_cutoff_runid
  from cron.job_run_details;

  if v_cutoff_runid is null then
    return 0;
  end if;

  with doomed as (
    select runid
    from cron.job_run_details
    where runid < v_cutoff_runid
    order by runid
    limit v_limit
  )
  delete from cron.job_run_details d
  using doomed
  where d.runid = doomed.runid;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function public.cleanup_cron_job_run_details_batch(interval, integer) is
'Keeps approximately the latest 60,000 pg_cron run records and deletes older rows in small batches. The interval argument is retained for call compatibility; runid retention is used so cleanup can use the primary-key index without a full scan on start_time.';
