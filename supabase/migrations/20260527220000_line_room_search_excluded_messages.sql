-- 検索操作で送ったトークを記録・検索結果から除外

create table if not exists public.line_room_search_excluded_messages (
  line_message_id text primary key,
  room_id text not null,
  text_content text not null default '',
  excluded_at timestamptz not null default now()
);

create index if not exists line_room_search_excluded_messages_room_idx
  on public.line_room_search_excluded_messages (room_id, excluded_at desc);

create or replace function public.mark_line_room_search_excluded_message(
  p_line_message_id text,
  p_room_id text,
  p_text_content text default ''
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(btrim(p_line_message_id), '') = '' then
    return;
  end if;
  if not public.is_valid_line_room_id(p_room_id) then
    return;
  end if;

  insert into public.line_room_search_excluded_messages (
    line_message_id, room_id, text_content
  ) values (
    btrim(p_line_message_id),
    p_room_id,
    coalesce(btrim(p_text_content), '')
  )
  on conflict (line_message_id) do update set
    text_content = excluded.text_content,
    excluded_at = now();
end;
$$;

create or replace function public.purge_line_message_from_search_archives(
  p_line_message_id text,
  p_room_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  tbl text;
  mid text;
begin
  mid := nullif(btrim(p_line_message_id), '');
  if mid is null or not public.is_valid_line_room_id(p_room_id) then
    return;
  end if;

  delete from public.line_room_messages_search
  where line_message_id = mid and room_id = p_room_id;

  delete from public.line_room_calendar_search
  where line_message_id = mid and room_id = p_room_id;

  select message_table into tbl
  from public.line_room_message_tables
  where room_id = p_room_id;

  if tbl is not null then
    execute format('delete from public.%I where line_message_id = $1', tbl)
    using mid;
  end if;
end;
$$;

-- 会話検索: 検索操作トークを結果から除外
create or replace function public.search_line_room_messages(
  p_query text,
  p_room_id text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  id bigint,
  room_id text,
  room_message_id bigint,
  line_message_id text,
  user_id text,
  message_type text,
  text_content text,
  created_at timestamptz,
  total_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  q text;
  lim int;
  off int;
  since timestamptz := now() - interval '365 days';
begin
  q := btrim(coalesce(p_query, ''));
  if length(q) < 1 then
    raise exception 'query required';
  end if;

  lim := greatest(1, least(coalesce(p_limit, 50), 100));
  off := greatest(coalesce(p_offset, 0), 0);

  if p_room_id is not null and btrim(p_room_id) <> '' and not public.is_valid_line_room_id(p_room_id) then
    raise exception 'invalid room_id: %', p_room_id;
  end if;

  return query
  with searchable_rooms as (
    select rs.room_id
    from public.room_summary_settings rs
    where rs.message_search_enabled = true
  ),
  filtered as (
    select s.*
    from public.line_room_messages_search s
    inner join searchable_rooms sr on sr.room_id = s.room_id
    where s.created_at >= since
      and (p_room_id is null or btrim(p_room_id) = '' or s.room_id = p_room_id)
      and s.text_content ilike '%' || replace(replace(q, '\', '\\'), '%', '\%') || '%' escape '\'
      and not public.is_line_search_control_text(s.text_content)
      and not exists (
        select 1
        from public.line_room_search_excluded_messages e
        where e.line_message_id is not null
          and e.line_message_id = s.line_message_id
      )
  ),
  counted as (
    select count(*)::bigint as cnt from filtered
  )
  select
    f.id,
    f.room_id,
    f.room_message_id,
    f.line_message_id,
    f.user_id,
    f.message_type,
    f.text_content,
    f.created_at,
    c.cnt
  from filtered f
  cross join counted c
  order by f.created_at desc
  limit lim
  offset off;
end;
$$;

-- 既存の検索操作トークを再掃除
select public.purge_line_search_control_messages();

insert into public.line_room_search_excluded_messages (line_message_id, room_id, text_content)
select s.line_message_id, s.room_id, s.text_content
from public.line_room_messages_search s
where s.line_message_id is not null
  and public.is_line_search_control_text(s.text_content)
on conflict (line_message_id) do nothing;

alter table public.line_room_search_excluded_messages enable row level security;
