-- 新旧管理画面でルーム削除（一覧除外）を独立させる。
alter table public.line_room_dismissed
  add column if not exists admin_surface text;

update public.line_room_dismissed
set admin_surface = 'legacy'
where admin_surface is null or btrim(admin_surface) = '';

alter table public.line_room_dismissed
  alter column admin_surface set default 'legacy',
  alter column admin_surface set not null;

alter table public.line_room_dismissed
  drop constraint if exists line_room_dismissed_pkey;

alter table public.line_room_dismissed
  add constraint line_room_dismissed_pkey primary key (room_id, admin_surface);

comment on column public.line_room_dismissed.admin_surface is
  '管理画面種別: legacy=旧サイト, line_report=新サイト（Webhook/レシート管理）';

create index if not exists idx_line_room_dismissed_surface_dismissed_at
  on public.line_room_dismissed (admin_surface, dismissed_at desc);

drop function if exists public.get_room_overview();

create function public.get_room_overview(p_admin_surface text default 'legacy')
returns table (
  room_id text,
  room_name text,
  total_messages bigint,
  pending_messages bigint,
  last_message_at timestamptz,
  last_pending_at timestamptz,
  settings_enabled boolean,
  settings_delivery_hours integer[],
  settings_updated_at timestamptz
)
language sql
security definer
set search_path = public
as $$
with message_stats as (
    select
        lm.room_id,
        count(*)::bigint as total_messages,
        count(*) filter (where lm.processed = false)::bigint as pending_messages,
        max(lm.created_at) as last_message_at,
        max(lm.created_at) filter (where lm.processed = false) as last_pending_at
    from public.line_messages lm
    group by lm.room_id
),
all_room_ids as (
    select room_id from message_stats
    union
    select room_id from public.room_summary_settings
    union
    select room_id from public.line_room_names
),
surface as (
    select coalesce(nullif(btrim(p_admin_surface), ''), 'legacy') as admin_surface
)
select
    r.room_id,
    coalesce(rs.room_name, rn.room_name, r.room_id) as room_name,
    coalesce(ms.total_messages, 0)::bigint as total_messages,
    coalesce(ms.pending_messages, 0)::bigint as pending_messages,
    ms.last_message_at,
    ms.last_pending_at,
    coalesce(rs.is_enabled, true) as settings_enabled,
    rs.delivery_hours as settings_delivery_hours,
    rs.updated_at as settings_updated_at
from all_room_ids r
cross join surface s
left join message_stats ms on ms.room_id = r.room_id
left join public.room_summary_settings rs on rs.room_id = r.room_id
left join public.line_room_names rn on rn.room_id = r.room_id
where not exists (
  select 1
  from public.line_room_dismissed d
  where d.room_id = r.room_id
    and d.admin_surface = s.admin_surface
)
order by coalesce(ms.last_message_at, rs.updated_at, rn.updated_at) desc nulls last, r.room_id asc;
$$;
