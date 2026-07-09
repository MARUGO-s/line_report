-- AI使用料の時系列（日次・月次）集計用。
-- p_by: 'day' または 'month'
create or replace function public.ai_usage_time_series(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_by text default 'day'
)
returns table (
  period_date text,
  provider text,
  model text,
  event_count bigint,
  input_tokens bigint,
  output_tokens bigint,
  thinking_tokens bigint,
  total_tokens bigint
)
language sql
security definer
set search_path = public
as $$
  select
    to_char(timezone('Asia/Tokyo', e.created_at), case when p_by = 'month' then 'YYYY/MM' else 'YYYY/MM/DD' end) as period_date,
    e.provider,
    coalesce(e.model, '') as model,
    count(*)::bigint as event_count,
    coalesce(sum(e.input_tokens), 0)::bigint as input_tokens,
    coalesce(sum(e.output_tokens), 0)::bigint as output_tokens,
    coalesce(sum(e.thinking_tokens), 0)::bigint as thinking_tokens,
    coalesce(sum(e.total_tokens), 0)::bigint as total_tokens
  from public.ai_usage_events e
  where (p_from is null or e.created_at >= p_from)
    and (p_to is null or e.created_at < p_to)
  group by period_date, e.provider, coalesce(e.model, '')
  order by period_date desc, e.provider, coalesce(e.model, '');
$$;

comment on function public.ai_usage_time_series(timestamptz, timestamptz, text) is
  'AI使用料概算用: 指定期間内の実測トークンを日次または月次の時系列に集計して返す。';

grant execute on function public.ai_usage_time_series(timestamptz, timestamptz, text) to service_role;
