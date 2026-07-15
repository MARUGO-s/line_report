-- 合格済み、または人が helpful と評価した回答を自動でRAG文書へ同期する。
-- RLS + service_role 専用とし、ブラウザからテーブルへ直接アクセスさせない。

create table if not exists public.foodcourt_ai_rag_documents (
  id uuid primary key default gen_random_uuid(),
  source_run_id uuid not null unique references public.foodcourt_ai_loop_runs(id) on delete cascade,
  store_partition_key text not null,
  surface text not null,
  source_type text not null check (source_type in ('quality_passed', 'human_helpful')),
  title text not null,
  document_markdown text not null,
  search_text text not null,
  final_score numeric(5,2),
  metadata jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_foodcourt_ai_rag_lookup
  on public.foodcourt_ai_rag_documents (store_partition_key, surface, is_active, updated_at desc);

alter table public.foodcourt_ai_rag_documents enable row level security;
grant select, insert, update, delete on public.foodcourt_ai_rag_documents to service_role;

comment on table public.foodcourt_ai_rag_documents is
  'フードコートAIの承認済み回答をMarkdown文書として永続化したRAG検索コーパス。DBトリガーが自動更新する。';

create or replace function public.sync_foodcourt_ai_rag_document(p_run_id uuid)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_run public.foodcourt_ai_loop_runs%rowtype;
  v_feedback_rating text;
  v_feedback_note text;
  v_risk_flags jsonb := '[]'::jsonb;
  v_risk_markdown text := '';
  v_source_type text;
  v_surface_label text;
  v_markdown text;
begin
  select * into v_run
  from public.foodcourt_ai_loop_runs
  where id = p_run_id;

  if not found then
    return;
  end if;

  select rating, note
    into v_feedback_rating, v_feedback_note
  from public.foodcourt_ai_feedback
  where run_id = p_run_id;

  if v_run.final_answer is null
     or v_run.status <> 'completed'
     or v_feedback_rating = 'not_helpful'
     or (coalesce(v_run.returned_reason, '') <> 'passed' and coalesce(v_feedback_rating, '') <> 'helpful') then
    update public.foodcourt_ai_rag_documents
    set is_active = false,
        updated_at = now()
    where source_run_id = p_run_id;
    return;
  end if;

  select
    coalesce(jsonb_agg(distinct risk_text), '[]'::jsonb),
    coalesce(string_agg(distinct '- ' || risk_text, E'\n'), '')
  into v_risk_flags, v_risk_markdown
  from (
    select trim(risk.value) as risk_text
    from public.foodcourt_ai_loop_iterations iteration
    cross join lateral jsonb_array_elements_text(
      case
        when jsonb_typeof(iteration.evaluation -> 'risk_flags') = 'array'
          then iteration.evaluation -> 'risk_flags'
        else '[]'::jsonb
      end
    ) risk(value)
    where iteration.run_id = p_run_id
      and trim(risk.value) <> ''
  ) risks;

  v_source_type := case when v_feedback_rating = 'helpful' then 'human_helpful' else 'quality_passed' end;
  v_surface_label := case v_run.surface
    when 'ask' then 'Q&A'
    when 'daily_summary' then '日次サマリー'
    when 'period_summary' then '期間サマリー'
    when 'weekly_report' then '週次レポート'
    else v_run.surface
  end;

  v_markdown := concat(
    '# ', v_surface_label, ' 学習記録', E'\n\n',
    '- 店舗: ', v_run.store_partition_key, E'\n',
    '- 作成日時: ', to_char(v_run.created_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI'), E' JST\n',
    '- 承認方法: ', case when v_source_type = 'human_helpful' then '人による承認' else '品質評価合格' end, E'\n',
    '- 評価点: ', coalesce(v_run.final_score::text, '人による承認'), E'\n\n',
    '## 分析タスク', E'\n', coalesce(nullif(v_run.user_input, ''), '定型分析'), E'\n\n',
    '## 対象データ', E'\n```json\n', jsonb_pretty(v_run.source_ref), E'\n```\n\n',
    '## 承認済み回答', E'\n', v_run.final_answer,
    case when v_risk_markdown <> '' then E'\n\n## 再利用時の注意事項\n' || v_risk_markdown else '' end,
    case when coalesce(v_feedback_note, '') <> '' then E'\n\n## 人のメモ\n' || v_feedback_note else '' end,
    E'\n'
  );

  insert into public.foodcourt_ai_rag_documents (
    source_run_id, store_partition_key, surface, source_type, title,
    document_markdown, search_text, final_score, metadata, is_active, updated_at
  ) values (
    p_run_id,
    lower(v_run.store_partition_key),
    v_run.surface,
    v_source_type,
    v_surface_label || ' ' || to_char(v_run.created_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI'),
    v_markdown,
    concat_ws(E'\n', v_run.user_input, v_run.source_ref::text, v_run.final_answer, v_risk_markdown, v_feedback_note),
    v_run.final_score,
    jsonb_build_object(
      'source_ref', v_run.source_ref,
      'returned_reason', v_run.returned_reason,
      'feedback_rating', v_feedback_rating,
      'risk_flags', v_risk_flags,
      'model_version', v_run.model_version
    ),
    true,
    now()
  )
  on conflict (source_run_id) do update set
    store_partition_key = excluded.store_partition_key,
    surface = excluded.surface,
    source_type = excluded.source_type,
    title = excluded.title,
    document_markdown = excluded.document_markdown,
    search_text = excluded.search_text,
    final_score = excluded.final_score,
    metadata = excluded.metadata,
    is_active = true,
    updated_at = now();
end;
$$;

revoke all on function public.sync_foodcourt_ai_rag_document(uuid) from public, anon, authenticated;
grant execute on function public.sync_foodcourt_ai_rag_document(uuid) to service_role;

create or replace function public.trg_sync_foodcourt_ai_rag_from_run()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  perform public.sync_foodcourt_ai_rag_document(new.id);
  return new;
end;
$$;

create or replace function public.trg_sync_foodcourt_ai_rag_from_feedback()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    perform public.sync_foodcourt_ai_rag_document(old.run_id);
    return old;
  end if;
  perform public.sync_foodcourt_ai_rag_document(new.run_id);
  return new;
end;
$$;

revoke all on function public.trg_sync_foodcourt_ai_rag_from_run() from public, anon, authenticated;
revoke all on function public.trg_sync_foodcourt_ai_rag_from_feedback() from public, anon, authenticated;

drop trigger if exists foodcourt_ai_rag_from_run on public.foodcourt_ai_loop_runs;
create trigger foodcourt_ai_rag_from_run
after insert or update on public.foodcourt_ai_loop_runs
for each row execute function public.trg_sync_foodcourt_ai_rag_from_run();

drop trigger if exists foodcourt_ai_rag_from_feedback on public.foodcourt_ai_feedback;
create trigger foodcourt_ai_rag_from_feedback
after insert or update or delete on public.foodcourt_ai_feedback
for each row execute function public.trg_sync_foodcourt_ai_rag_from_feedback();

-- 既存の合格・承認済み回答も初回デプロイ時にRAGへ取り込む。
do $$
declare
  v_run_id uuid;
begin
  for v_run_id in
    select id from public.foodcourt_ai_loop_runs where final_answer is not null
  loop
    perform public.sync_foodcourt_ai_rag_document(v_run_id);
  end loop;
end;
$$;
