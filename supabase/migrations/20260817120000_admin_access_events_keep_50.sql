-- アクセス履歴は最新50件だけ残す。追加のたびに古い行を消す。
create or replace function public.prune_admin_access_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.admin_access_events
  where id in (
    select id
    from public.admin_access_events
    order by created_at desc, id desc
    offset 50
  );
  return null;
end;
$$;

drop trigger if exists admin_access_events_prune on public.admin_access_events;
create trigger admin_access_events_prune
after insert on public.admin_access_events
for each statement
execute function public.prune_admin_access_events();

delete from public.admin_access_events
where id in (
  select id
  from public.admin_access_events
  order by created_at desc, id desc
  offset 50
);

revoke all on function public.prune_admin_access_events() from public, anon, authenticated;
grant execute on function public.prune_admin_access_events() to service_role;

comment on function public.prune_admin_access_events() is
  'admin_access_events を最新50件に保つ。INSERT 後に古い行を削除する。';
