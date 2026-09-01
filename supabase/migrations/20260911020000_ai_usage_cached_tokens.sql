-- 分析AIの所要時間を、推測ではなく実測で切り分けられるようにする。
--
-- これまで記録していたのは入力・出力・合計トークンだけだった。そのため
-- 「プロンプトキャッシュが効いているのか」「時間を食っているのは思考か出力か」
-- を判断できず、速度改善の議論が推測に頼っていた。
--
-- cached_tokens: プロンプトのうちキャッシュから読まれた分。大きいほど
--   前段(prefill)が短縮されている。0 が続くならキャッシュが効いていない。
-- thinking_tokens: 既存列だが、これまで常に null を入れていた。推論モデルは
--   思考トークンが完了枠と実時間の両方を消費するため、遅さの直接的な説明になる。
alter table public.ai_usage_events
  add column if not exists cached_tokens bigint;

comment on column public.ai_usage_events.cached_tokens is
  'プロンプトのうちキャッシュから読まれたトークン数。prefill がどれだけ短縮されたかの指標。';
comment on column public.ai_usage_events.thinking_tokens is
  '推論モデルの思考トークン数。完了枠と実時間の両方を消費するため、応答時間の内訳把握に使う。';
