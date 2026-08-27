-- Keep M-talk browser access on reviewed RPCs and policy gates only.
--
-- These helpers run exclusively inside SECURITY DEFINER functions owned by the
-- database role. Exposing them through PostgREST lets an authenticated caller
-- probe another user's store affiliation or invoke implementation details
-- directly, even though the result is only a boolean or a display value.

revoke execute on function public.chat_can_browse_users()
  from public, anon, authenticated;
revoke execute on function public.chat_is_member(bigint)
  from public, anon, authenticated;
revoke execute on function public.chat_is_member_path(text)
  from public, anon, authenticated;
revoke execute on function public.chat_is_signup_manager(uuid)
  from public, anon, authenticated;
revoke execute on function public.chat_normalize_store_keys(text[])
  from public, anon, authenticated;
revoke execute on function public.chat_shares_affiliation(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.chat_store_display_names(text[])
  from public, anon, authenticated;
revoke execute on function public.chat_user_can_join_group_by_store(bigint, uuid)
  from public, anon, authenticated;
revoke execute on function public.chat_user_store_keys(uuid)
  from public, anon, authenticated;

grant execute on function public.chat_can_browse_users()
  to postgres, service_role;
grant execute on function public.chat_is_member(bigint)
  to postgres, service_role;
grant execute on function public.chat_is_member_path(text)
  to postgres, service_role;
grant execute on function public.chat_is_signup_manager(uuid)
  to postgres, service_role;
grant execute on function public.chat_normalize_store_keys(text[])
  to postgres, service_role;
grant execute on function public.chat_shares_affiliation(uuid, uuid)
  to postgres, service_role;
grant execute on function public.chat_store_display_names(text[])
  to postgres, service_role;
grant execute on function public.chat_user_can_join_group_by_store(bigint, uuid)
  to postgres, service_role;
grant execute on function public.chat_user_store_keys(uuid)
  to postgres, service_role;
