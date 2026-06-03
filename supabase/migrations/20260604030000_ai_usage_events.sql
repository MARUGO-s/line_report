-- AI使用料（実測）用。レシート画像をAI解析するたびに、APIが返す実測トークン使用量を1行ずつ記録する。
-- これにより AI使用料ページを「画像件数×推測単価」の概算から「実測トークン×公式単価」へ事実ベース化する。
--
-- トークンの取り方（receipt_vision.ts 側）:
--   Gemini: input = usageMetadata.promptTokenCount
--           total = usageMetadata.totalTokenCount
--           output = max(0, total - input)   ← 思考(thinking)トークン込みの課金対象出力を堅牢に算出
--           thinking = usageMetadata.thoughtsTokenCount（参考・取得できない版もあるため nullable）
--   Groq:   input = usage.prompt_tokens / output = usage.completion_tokens / total = usage.total_tokens（thinking なし）
--
-- provider は「実際に応答を返したプロバイダ」を入れる（Gemini採用店が Groq へフォールバックした場合は 'groq'）。

create table if not exists public.ai_usage_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  store_partition_key text not null,
  provider text not null,                 -- 'gemini' | 'groq'
  model text,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0, -- 課金対象の出力（Geminiは思考込み = total - prompt）
  thinking_tokens bigint,                  -- Gemini の思考トークン（参考・取得不可なら null）
  total_tokens bigint not null default 0,
  line_message_id text
);

create index if not exists ai_usage_events_created_idx
  on public.ai_usage_events (created_at);
create index if not exists ai_usage_events_provider_created_idx
  on public.ai_usage_events (provider, created_at);
create index if not exists ai_usage_events_store_created_idx
  on public.ai_usage_events (store_partition_key, created_at);

-- anon からの読み書きを遮断（Edge Function は service_role キーで RLS をバイパスして書き込む）。
alter table public.ai_usage_events enable row level security;

comment on table public.ai_usage_events is
  'AI使用料（実測）: レシート画像のAI解析1回ごとの実測トークン使用量。provider は実際に応答したプロバイダ。';

-- プロバイダ別の実測トークン合計（期間指定可）。AI使用料ページの「実測」表示用。
create or replace function public.ai_usage_token_totals(
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (
  provider text,
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
    e.provider,
    count(*)::bigint as event_count,
    coalesce(sum(e.input_tokens), 0)::bigint as input_tokens,
    coalesce(sum(e.output_tokens), 0)::bigint as output_tokens,
    coalesce(sum(e.thinking_tokens), 0)::bigint as thinking_tokens,
    coalesce(sum(e.total_tokens), 0)::bigint as total_tokens
  from public.ai_usage_events e
  where (p_from is null or e.created_at >= p_from)
    and (p_to is null or e.created_at < p_to)
  group by e.provider;
$$;

comment on function public.ai_usage_token_totals(timestamptz, timestamptz) is
  'AI使用料概算用: 期間内の実測トークンをプロバイダ(gemini/groq)別に合計して返す。';

grant execute on function public.ai_usage_token_totals(timestamptz, timestamptz) to service_role;
