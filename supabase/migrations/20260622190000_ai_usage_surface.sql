-- AI使用量を「用途（surface）」で区別できるようにする。
-- 同じ店舗(marugoS)でもレシート解析と「フードコート分析(Q&A・テナント表画像抽出・ドームイベント抽出)」が
-- 混在するため、分析用途のイベントだけを別表示できるよう surface 列を追加する。
-- 既存行は null（=レシート解析など従来用途）。フードコート分析の記録は 'foodcourt' を入れる。
alter table public.ai_usage_events add column if not exists surface text;

-- 店舗・用途で絞ったモデル別トークン合計（AI使用料をモデル別単価で正確計算するため）。
-- 既存 ai_usage_model_totals と同型・同セキュリティ。anon には EXECUTE を付与しない。
create or replace function public.ai_usage_surface_model_totals(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_store text default null,
  p_surface text default null
)
returns table(
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
set search_path to 'public'
as $function$
  select
    e.provider,
    coalesce(nullif(e.model, ''), '(unknown)') as model,
    count(*)::bigint as event_count,
    coalesce(sum(e.input_tokens), 0)::bigint as input_tokens,
    coalesce(sum(e.output_tokens), 0)::bigint as output_tokens,
    coalesce(sum(e.thinking_tokens), 0)::bigint as thinking_tokens,
    coalesce(sum(e.total_tokens), 0)::bigint as total_tokens
  from public.ai_usage_events e
  where (p_from is null or e.created_at >= p_from)
    and (p_to is null or e.created_at < p_to)
    and (p_store is null or e.store_partition_key = p_store)
    and (p_surface is null or e.surface = p_surface)
  group by e.provider, coalesce(nullif(e.model, ''), '(unknown)');
$function$;

revoke all on function public.ai_usage_surface_model_totals(timestamptz, timestamptz, text, text) from public, anon;
grant execute on function public.ai_usage_surface_model_totals(timestamptz, timestamptz, text, text) to authenticated, service_role;
