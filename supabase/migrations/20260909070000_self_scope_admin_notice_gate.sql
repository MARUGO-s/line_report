-- The RLS gate is callable by authenticated users, so it must not allow a
-- caller to probe whether some other user is an approval manager. The push
-- backend still needs to evaluate recipients in bulk with its service-role JWT.

create or replace function public.chat_can_see_admin_notice(
  p_group_id bigint,
  p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select (
    p_user_id = auth.uid()
    or (select auth.role()) = 'service_role'
  ) and public.chat_has_active_access(p_user_id) and (
    exists (
      select 1
      from public.chat_group_members gm
      join public.chat_groups g on g.id = gm.group_id
      where gm.group_id = p_group_id
        and gm.user_id = p_user_id
        and gm.can_view = true
        and gm.can_manage = true
        and not coalesce(g.is_direct, false)
        and g.trashed_at is null
    )
    or (
      public.chat_is_signup_manager(p_user_id)
      and exists (
        select 1
        from public.chat_groups g
        where g.id = p_group_id
          and coalesce(g.is_direct, false)
      )
    )
  )
$fn$;

revoke all on function public.chat_can_see_admin_notice(bigint, uuid)
  from public, anon;
grant execute on function public.chat_can_see_admin_notice(bigint, uuid)
  to authenticated, service_role;
