-- 各AI（専門AI①〜③・反証AI④・統合AI⑤・評価AI⑥）が希望プロバイダ/モデルで反応せず、
-- 別プロバイダ/別モデルへフォールバックした事象を記録するテーブル。
-- 内部処理で握りつぶしていたフォールバックを、管理画面で即座に確認できるようにする。
create table if not exists public.foodcourt_ai_fallback_events (
  id bigint generated always as identity primary key,
  store_partition_key text not null,
  surface text not null,               -- ask | daily_summary | period_summary | weekly_report | tenant_extract 等
  role text not null,                  -- specialist_quant | specialist_ext | specialist_ops | critic | integrator | evaluator 等
  preferred_provider text not null,    -- 本来使いたかったプロバイダ
  preferred_model text,                -- 本来使いたかったモデル（分かる場合）
  used_provider text,                  -- 実際に成功したプロバイダ（全滅時は null）
  used_model text,                     -- 実際に成功したモデル（全滅時は null）
  outcome text not null,               -- fallback_success | all_failed
  attempts jsonb not null default '[]'::jsonb, -- [{provider,model,ok,reason}] の試行ログ
  acknowledged boolean not null default false, -- 管理画面で確認済みにしたか
  created_at timestamptz not null default now()
);

create index if not exists idx_foodcourt_ai_fallback_store_created
  on public.foodcourt_ai_fallback_events (store_partition_key, created_at desc);

-- 未確認（acknowledged=false）の絞り込みを速くする部分インデックス。
create index if not exists idx_foodcourt_ai_fallback_unacked
  on public.foodcourt_ai_fallback_events (store_partition_key, created_at desc)
  where acknowledged = false;

alter table public.foodcourt_ai_fallback_events enable row level security;
grant select, insert, update on public.foodcourt_ai_fallback_events to service_role;

comment on table public.foodcourt_ai_fallback_events is
  'フードコート各AIが希望プロバイダ/モデルで反応せずフォールバックした事象の記録。admin-api(service_role)からのみ操作する。';
