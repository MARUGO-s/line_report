-- Security follow-up: protect security-sensitive columns even when a client
-- calls PostgREST directly, and enforce the icon policy in Storage itself.

-- Room managers may update only presentation fields. Ownership, store
-- binding, direct-room, notice-room and trash fields remain RPC controlled.
revoke update on table public.chat_groups from authenticated;
grant update (group_name, icon_url) on table public.chat_groups to authenticated;

-- Users may update only their own visible profile fields. Existing RLS and
-- the system-column trigger remain as additional independent safeguards.
revoke update on table public.chat_users from authenticated;
grant update (username, icon_url) on table public.chat_users to authenticated;

-- Message edits are limited at the SQL privilege layer as well as by RLS and
-- chat_guard_message_edit(). The trigger owns edited_at/edit_history; browser
-- callers only submit the new text and the room-filtered mention list.
revoke update on table public.chat_messages from authenticated;
grant update (content, mentions) on table public.chat_messages to authenticated;

alter table public.chat_groups
  drop constraint if exists chat_groups_group_name_length_check,
  add constraint chat_groups_group_name_length_check
    check (length(btrim(group_name)) between 1 and 120),
  drop constraint if exists chat_groups_icon_url_length_check,
  add constraint chat_groups_icon_url_length_check
    check (icon_url is null or length(icon_url) <= 2048);

alter table public.chat_users
  drop constraint if exists chat_users_username_length_check,
  add constraint chat_users_username_length_check
    check (length(btrim(username)) between 1 and 80),
  drop constraint if exists chat_users_icon_url_length_check,
  add constraint chat_users_icon_url_length_check
    check (icon_url is null or length(icon_url) <= 2048);

-- The browser already rejects SVG icon uploads. Remove SVG from the public
-- bucket allowlist as well so direct Storage API calls cannot bypass the UI.
update storage.buckets
set allowed_mime_types = array[
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
]::text[]
where id = 'chat-icons';
