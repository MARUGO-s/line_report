update room_summary_settings
set
  bot_access_approved = true,
  updated_at = now()
where bot_access_approved is distinct from true;
