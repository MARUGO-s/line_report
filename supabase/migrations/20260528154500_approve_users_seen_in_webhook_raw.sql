do $$
declare
  rec record;
begin
  for rec in
    select distinct webhook_raw_table
    from store_webhook_tables
    where webhook_raw_table is not null
      and webhook_raw_table <> ''
  loop
    execute format(
      $sql$
      insert into line_user_permissions (
        line_user_id,
        is_active,
        can_message_search,
        can_library_search,
        can_calendar_create,
        can_calendar_update,
        can_calendar_view,
        can_media_access,
        updated_at
      )
      select distinct
        r.user_id,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        now()
      from %I r
      where r.user_id is not null
        and r.user_id like 'U%%'
      on conflict (line_user_id) do update
      set
        is_active = true,
        can_message_search = true,
        can_library_search = true,
        can_calendar_create = true,
        can_calendar_update = true,
        can_calendar_view = true,
        can_media_access = true,
        updated_at = now()
      $sql$,
      rec.webhook_raw_table
    );
  end loop;
end $$;
