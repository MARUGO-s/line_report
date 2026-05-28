update line_user_permissions
set
  is_active = true,
  can_message_search = true,
  can_library_search = true,
  can_calendar_create = true,
  can_calendar_update = true,
  can_calendar_view = true,
  can_media_access = true,
  updated_at = now()
where is_active is distinct from true
   or can_message_search is distinct from true
   or can_library_search is distinct from true
   or can_calendar_create is distinct from true
   or can_calendar_update is distinct from true
   or can_calendar_view is distinct from true
   or can_media_access is distinct from true;
