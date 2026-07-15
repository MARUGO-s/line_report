-- 月次振り返り（前月のAI要約）を保存し、日次のAI分析生成に「学習材料」として渡すためのキャッシュ。
-- 既存の generateFoodCourtPeriodSummary（期間サマリー生成）を月境界で呼び出して生成する。
-- 月ごとに1回だけ生成し、以降は同じ月分をキャッシュから返す（再生成・再課金しない）。
create table if not exists public.foodcourt_monthly_retrospective (
  id                  bigint generated always as identity primary key,
  store_partition_key text not null,
  year_month          text not null, -- 'YYYY-MM'
  month_start         date not null,
  month_end           date not null,
  summary_text        text not null,
  model_version       text not null,
  created_at          timestamptz not null default now(),
  constraint uq_fcmr_store_month unique (store_partition_key, year_month)
);

comment on table public.foodcourt_monthly_retrospective
  is '月次振り返り（AI生成）。日次のAI分析サマリーに「前月の振り返り」として渡し、中長期トレンドを踏まえた分析にするための学習材料。';

create index if not exists idx_fcmr_store_month on public.foodcourt_monthly_retrospective(store_partition_key, year_month desc);

alter table public.foodcourt_monthly_retrospective enable row level security;
grant select, insert, update, delete on public.foodcourt_monthly_retrospective to service_role;
