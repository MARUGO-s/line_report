update room_summary_settings
set
  bot_access_approved = true,
  bot_reply_hard_mute_enabled = false,
  message_search_enabled = true,
  message_search_library_enabled = true,
  media_file_access_enabled = true,
  receipt_midreport_enabled = true,
  receipt_monthend_report_enabled = true,
  updated_at = now()
where bot_access_approved is distinct from true
   or bot_reply_hard_mute_enabled is distinct from false
   or message_search_enabled is distinct from true
   or message_search_library_enabled is distinct from true
   or media_file_access_enabled is distinct from true
   or receipt_midreport_enabled is distinct from true
   or receipt_monthend_report_enabled is distinct from true;

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
