-- Read-only administration metrics. Never infer LINE billing from delivery logs.
create or replace function public.get_storage_usage_stats()
returns jsonb language sql security definer
set search_path = pg_catalog, public
as $$
  with sizes as materialized (
    -- Physical tables (including partition leaves) and materialized views only.
    -- pg_total_relation_size already includes indexes and TOAST; no double count.
    select c.relname as table_name, pg_total_relation_size(c.oid) as size_bytes
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'm')
  ), totals as (select coalesce(sum(size_bytes),0)::bigint as bytes from sizes)
  select jsonb_build_object(
    'scope', 'public_relations', 'measured_at', statement_timestamp(),
    'database_size_bytes', pg_database_size(current_database()),
    'managed_tables_total_bytes', totals.bytes,
    'managed_tables', coalesce((select jsonb_agg(jsonb_build_object(
      'table_name', table_name, 'size_bytes', size_bytes
    ) order by size_bytes desc, table_name) from sizes), '[]'::jsonb)
  ) from totals;
$$;
revoke all on function public.get_storage_usage_stats() from public, anon, authenticated;
grant execute on function public.get_storage_usage_stats() to service_role;

create or replace function public.get_usage_monthly(p_month text default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  month_label text := coalesce(p_month, to_char(statement_timestamp() at time zone 'Asia/Tokyo', 'YYYY-MM'));
  period_start timestamptz;
  period_end timestamptz;
  result jsonb;
begin
  if month_label !~ '^20[0-9]{2}-(0[1-9]|1[0-2])$' then
    raise exception 'Invalid month (YYYY-MM)' using errcode = '22023';
  end if;
  period_start := (month_label || '-01')::timestamp at time zone 'Asia/Tokyo';
  period_end := ((month_label || '-01')::timestamp + interval '1 month') at time zone 'Asia/Tokyo';
  with raw_events as (
    select target_room_id as room_id, store_partition_key as store_key, method as kind,
      'LINE webhook'::text as source, coalesce(nullif(context,''),'push') as context, false as unverified
    from public.line_webhook_delivery_logs
    where line_send_success and method in ('push','reply') and created_at >= period_start and created_at < period_end
    union all
    select target_room_id, null, 'push', coalesce(nullif(details->>'source',''),'summary'),
      coalesce(nullif(details->>'context',''),nullif(reason,''),'summary'), false
    from public.summary_delivery_logs
    where line_send_attempted and line_send_success and run_at >= period_start and run_at < period_end
    union all
    select line_target_room_id, null, 'push', 'Gmail予約通知', '予約メール', false
    from public.gmail_reservation_alert_logs where line_message_sent_at >= period_start and line_message_sent_at < period_end
    union all
    select room_id, store_partition_key, 'push', '本日の予約配信', 'daily', false
    from public.reservation_today_alert_logs where sent_at >= period_start and sent_at < period_end
    union all
    select room_id, store_partition_key, 'push', '明日の予定配信', 'daily', false
    from public.calendar_tomorrow_reminder_logs where sent_at >= period_start and sent_at < period_end
    union all
    -- These two tables reserve rows BEFORE sending. Historical success cannot be proven.
    select room_id, store_partition_key, 'push', '東京ドーム週次配信', 'weekly', true
    from public.tokyo_dome_weekly_logs where sent_at >= period_start and sent_at < period_end and event_count > 0
    union all
    select room_id, null, 'push', 'レシートレポート', coalesce(nullif(report_kind,''),'report'), true
    from public.line_receipt_mid_reports where sent_at >= period_start and sent_at < period_end
  ), events as materialized (
    select coalesce(nullif(btrim(e.room_id),''),'') as room_id,
      coalesce(nullif(lower(btrim(e.store_key)),''),nullif(lower(btrim(r.receipt_report_store_partition_key)),''),'') as store_key,
      coalesce(r.room_name,'') as room_name, e.kind,e.source,e.context,e.unverified
    from raw_events e left join public.room_summary_settings r on r.room_id = e.room_id
    where coalesce(btrim(e.room_id),'') !~ '^mtalk-group-[0-9]+$'
  ), sources as (
    select source,context,count(*) as count, count(*) filter(where unverified) as unverified_count
    from events where kind='push' group by source,context
  ), stores as (
    select store_key,count(*) filter(where kind='push') as push,
      count(*) filter(where kind='reply') as reply,count(*) as total from events group by store_key
  ), rooms as (
    select room_id,room_name,store_key,count(*) filter(where kind='push') as push,
      count(*) filter(where kind='reply') as reply,count(*) as total from events group by room_id,room_name,store_key
  )
  select jsonb_build_object(
    'status','ok','month_jst',month_label,'generated_at',statement_timestamp(),
    'period_start',period_start,'period_end',period_end,'unit','log_records',
    'total_push_rows',count(*) filter(where kind='push'),
    'webhook_reply_rows',count(*) filter(where kind='reply'),
    'webhook_push_rows',count(*) filter(where kind='reply'), -- legacy alias, NOT quota
    'unverified_push_rows',count(*) filter(where kind='push' and unverified),
    'unassigned_rows',count(*) filter(where store_key=''),
    'free_quota_limit',null,'free_quota_remaining',null,
    'by_source_context',coalesce((select jsonb_agg(to_jsonb(s) order by count desc,source,context) from sources s),'[]'::jsonb),
    'by_store',coalesce((select jsonb_agg(to_jsonb(s) order by total desc,store_key) from stores s),'[]'::jsonb),
    'by_room',coalesce((select jsonb_agg(to_jsonb(r) order by total desc,room_id,store_key) from rooms r),'[]'::jsonb)
  ) into result from events;
  return result;
end;
$$;
revoke all on function public.get_usage_monthly(text) from public, anon, authenticated;
grant execute on function public.get_usage_monthly(text) to service_role;
comment on function public.get_usage_monthly(text) is 'Administrative log records, not LINE quota. Includes explicitly marked unverified reservation records; excludes M-talk-only rooms.';
