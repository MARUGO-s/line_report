-- 予約AIキャッシュを「軽量集計」と「氏名入り明細」に分離する。
-- 通常の売上分析はsummary_factsだけを読み、予約者名等が必要な質問だけfacts明細を読む。

alter table public.reservation_ai_store_cache
  add column if not exists summary_facts jsonb not null default '{}'::jsonb;

update public.reservation_ai_store_cache
set summary_facts = jsonb_build_object(
  'totals', coalesce(facts -> 'totals', '{}'::jsonb),
  'by_month', coalesce(facts -> 'by_month', '[]'::jsonb),
  'truncated', coalesce(facts -> 'truncated', 'false'::jsonb),
  'notes', coalesce(facts -> 'notes', '[]'::jsonb)
)
where summary_facts = '{}'::jsonb;

comment on column public.reservation_ai_store_cache.summary_facts is
  '氏名入りitemsを除いた軽量AI集計。通常分析はこの列だけを読む。';
