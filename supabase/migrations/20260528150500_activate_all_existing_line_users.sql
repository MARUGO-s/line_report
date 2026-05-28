update line_user_permissions
set
  is_active = true,
  can_message_search = true,
  updated_at = now()
where is_active is distinct from true
   or can_message_search is distinct from true;
