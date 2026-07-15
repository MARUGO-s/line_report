-- 管理画面の合格点をAIループと品質合格RAGの共通基準として使う。

insert into public.line_admin_console_settings (setting_key, setting_value, updated_at)
values ('foodcourt_evolution_passing_score', '65', now())
on conflict (setting_key) do nothing;

create or replace function public.refresh_foodcourt_quality_rag_for_passing_score()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_score integer;
begin
  if new.setting_key <> 'foodcourt_evolution_passing_score' then
    return new;
  end if;

  begin
    v_score := new.setting_value::integer;
  exception when invalid_text_representation then
    return new;
  end;

  if v_score < 30 or v_score > 95 then
    return new;
  end if;

  with desired as (
    select
      document.id,
      case
        when document.source_type = 'human_helpful' then
          coalesce(feedback.rating, '') <> 'not_helpful'
        else
          run.status = 'completed'
          and run.returned_reason = 'passed'
          and coalesce(feedback.rating, '') <> 'not_helpful'
          and coalesce(iteration.total_score, run.final_score, 0) >= v_score
          and least(
            coalesce(iteration.score_accuracy, 0),
            coalesce(iteration.score_logic, 0),
            coalesce(iteration.score_expertise, 0),
            coalesce(iteration.score_practicality, 0),
            coalesce(iteration.score_evidence, 0)
          ) >= v_score
      end as should_be_active
    from public.foodcourt_ai_rag_documents document
    join public.foodcourt_ai_loop_runs run
      on run.id = document.source_run_id
    left join public.foodcourt_ai_loop_iterations iteration
      on iteration.run_id = run.id
     and iteration.loop_index = run.best_loop_index
    left join public.foodcourt_ai_feedback feedback
      on feedback.run_id = run.id
  )
  update public.foodcourt_ai_rag_documents document
  set is_active = desired.should_be_active,
      updated_at = now()
  from desired
  where document.id = desired.id
    and document.is_active is distinct from desired.should_be_active;

  return new;
end;
$$;

revoke all on function public.refresh_foodcourt_quality_rag_for_passing_score()
  from public, anon, authenticated;
grant execute on function public.refresh_foodcourt_quality_rag_for_passing_score()
  to service_role;

drop trigger if exists foodcourt_quality_rag_passing_score_changed
  on public.line_admin_console_settings;
create trigger foodcourt_quality_rag_passing_score_changed
after insert or update of setting_value on public.line_admin_console_settings
for each row
when (new.setting_key = 'foodcourt_evolution_passing_score')
execute function public.refresh_foodcourt_quality_rag_for_passing_score();

-- 既に合格点が保存済みの環境でも、マイグレーション適用時に一度再判定する。
update public.line_admin_console_settings
set setting_value = setting_value
where setting_key = 'foodcourt_evolution_passing_score';
