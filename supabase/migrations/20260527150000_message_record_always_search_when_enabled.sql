-- 会話は常に記録。検索は room_summary_settings.message_search_enabled = true のルームのみ。

comment on table public.line_room_messages_search is
  '会話検索用インデックス（最大1年）。全ルームのメッセージを保持し、検索APIは message_search_enabled のルームのみ返す。';

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
