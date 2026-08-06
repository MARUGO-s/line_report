-- Journal AI のモデルフォールバック記録。
--
-- 背景: 2026-08-05〜06 に Journal AI が gpt-5.6-luna から claude-haiku-4-5 へ
-- 7回連続で退避したが、失敗理由がどこにも残っておらず原因を特定できなかった。
-- レスポンスJSONの fallbackFrom.error にだけ入っており、ブラウザを開いていないと消える。
-- foodcourt には foodcourt_ai_fallback_events があり、そちらは「全件 timeout」と即座に判明した。
-- 同等の記録を Journal 側にも持たせる。

create table if not exists public.journal_ai_fallback_events (
  id bigint generated always as identity primary key,
  store_partition_key text not null,
  role text not null,                       -- synthesizer / clarifier
  preferred_provider text,
  preferred_model text,
  used_provider text,                       -- 最終的に成功したもの。全滅時は null
  used_model text,
  outcome text not null,                    -- fallback_success / all_failed
  attempts jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.journal_ai_fallback_events is
  'Journal AI が既定モデルから退避した記録。attempts に各試行の provider/model/reason/error/budget/elapsed_ms を残す。admin-api（service role）経由のみ。';

comment on column public.journal_ai_fallback_events.attempts is
  '試行の配列。[{ok, provider, model, reason, error, max_completion_tokens, elapsed_ms}]。error は先頭500文字まで。';

create index if not exists journal_ai_fallback_events_store_created_idx
  on public.journal_ai_fallback_events (store_partition_key, created_at desc);

alter table public.journal_ai_fallback_events enable row level security;

-- anon / authenticated からの直接アクセスは拒否（ポリシーなし＝deny）。
-- 参照は service role を持つ Edge Function 経由に限る。
revoke all on public.journal_ai_fallback_events from anon, authenticated;
