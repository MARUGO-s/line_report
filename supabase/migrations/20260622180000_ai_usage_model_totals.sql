-- AI使用料をモデル別の公式単価で正確に計算するための RPC。
-- 既存 ai_usage_token_totals（provider粒度）と同型・同セキュリティで、provider×model 粒度の
-- 実測トークン合計を返す。これにより groq の llama-4-scout（レシート/画像抽出）と
-- llama-3.3-70b（フードコートQ&A・ドーム抽出）を別単価で計算でき、概算誤差をなくせる。
-- セキュリティ: SECURITY DEFINER だが anon には EXECUTE を付与しない（RLSバイパス防止の恒久前提）。
create or replace function public.ai_usage_model_totals(
  p_from timestamptz default null,
  p_to timestamptz default null
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
  group by e.provider, coalesce(nullif(e.model, ''), '(unknown)');
$function$;

revoke all on function public.ai_usage_model_totals(timestamptz, timestamptz) from public, anon;
grant execute on function public.ai_usage_model_totals(timestamptz, timestamptz) to authenticated, service_role;
