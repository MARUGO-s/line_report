-- 予定配信の複数リマインド（最大3スロット）対応
-- room_summary_settings に calendar_reminder_slots (jsonb) を追加
-- calendar_tomorrow_reminder_logs に slot_id を追加して同一スロットの同日重複送信を防止

alter table public.room_summary_settings
  add column if not exists calendar_reminder_slots jsonb;

comment on column public.room_summary_settings.calendar_reminder_slots
  is '予定配信のリマインド設定スロット一覧（JSON配列、最大3件。例: [{"id":"slot_1","target":"tomorrow","hour":19,"minute":0,"enabled":true},{"id":"slot_2","target":"today","hour":8,"minute":30,"enabled":true}]）';

alter table public.calendar_tomorrow_reminder_logs
  add column if not exists slot_id text not null default 'default';

comment on column public.calendar_tomorrow_reminder_logs
  is '予定配信の送信済み記録（room_id×対象日×slot_idで重複送信を防止）';

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'calendar_tomorrow_reminder_logs_room_date_uidx'
  ) then
    alter table public.calendar_tomorrow_reminder_logs
      drop constraint calendar_tomorrow_reminder_logs_room_date_uidx;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'calendar_tomorrow_reminder_logs_room_date_slot_uidx'
  ) then
    alter table public.calendar_tomorrow_reminder_logs
      add constraint calendar_tomorrow_reminder_logs_room_date_slot_uidx
      unique (room_id, target_date, slot_id);
  end if;
end $$;

-- 毎分の dispatcher から呼ばれるゲート関数を更新
create or replace function public.invoke_calendar_tomorrow_cron()
returns void
language plpgsql
security definer
set search_path = 'public', 'extensions'
as $$
declare
  v_now_jst timestamp := now() at time zone 'Asia/Tokyo';
  v_hour int := extract(hour from v_now_jst)::int;
  v_min int := extract(minute from v_now_jst)::int;
begin
  if not exists (
    select 1
    from public.room_summary_settings s
    where s.calendar_tomorrow_reminder_enabled = true
      and coalesce(s.is_enabled, true) = true
      and (
        -- 複数スロット設定がある場合
        (
          s.calendar_reminder_slots is not null
          and jsonb_typeof(s.calendar_reminder_slots) = 'array'
          and jsonb_array_length(s.calendar_reminder_slots) > 0
          and exists (
            select 1
            from jsonb_array_elements(s.calendar_reminder_slots) elem
            where coalesce((elem->>'enabled')::boolean, true) = true
              and coalesce((elem->>'hour')::int, 19) = v_hour
              and coalesce((elem->>'minute')::int, 0) = v_min
          )
        )
        or
        -- 従来設定（単一時刻）
        (
          (s.calendar_reminder_slots is null or jsonb_array_length(s.calendar_reminder_slots) = 0)
          and coalesce(s.calendar_tomorrow_reminder_hour, 19) = v_hour
          and coalesce(s.calendar_tomorrow_reminder_minute, 0) = v_min
        )
      )
  ) then
    return;
  end if;

  perform net.http_post(
    url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/calendar-tomorrow-cron',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || public.resolve_edge_cron_auth_token(),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
end;
$$;

revoke all on function public.invoke_calendar_tomorrow_cron() from public, anon, authenticated;
grant execute on function public.invoke_calendar_tomorrow_cron() to postgres, service_role;
