-- Cleanup: remove historical search-control talks from archives

create or replace function public.is_line_search_control_text(p_text text)
returns boolean
language sql
immutable
as $$
  with n as (
    select regexp_replace(lower(coalesce(btrim(p_text), '')), '\s+', '', 'g') as t
  )
  select
    t in (
      '検索',
      '検索ヘルプ',
      '検索の仕方',
      '検索方法',
      'ヘルプ',
      '使い方',
      'search',
      'help',
      '会話検索',
      'トーク検索',
      '会話を検索',
      '予定検索',
      'カレンダー検索',
      '予定を検索',
      'メディア検索',
      '画像検索',
      'ファイル検索',
      '売上検索',
      '売り上げ検索',
      'レシート検索',
      'キャンセル',
      'やめる',
      'cancel'
    )
    or t ~ '^20[0-9]{6}$'
  from n;
$$;

create or replace function public.purge_line_search_control_messages()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  search_deleted bigint := 0;
  calendar_deleted bigint := 0;
  room_deleted bigint := 0;
  rec record;
  n bigint;
begin
  delete from public.line_room_messages_search s
  where public.is_line_search_control_text(s.text_content);
  get diagnostics search_deleted = row_count;

  delete from public.line_room_calendar_search c
  where c.source = 'line_talk'
    and (
      public.is_line_search_control_text(c.event_title)
      or public.is_line_search_control_text(c.event_description)
    );
  get diagnostics calendar_deleted = row_count;

  for rec in select message_table from public.line_room_message_tables loop
    execute format(
      'delete from public.%I t where public.is_line_search_control_text(t.text_content)',
      rec.message_table
    );
    get diagnostics n = row_count;
    room_deleted := room_deleted + coalesce(n, 0);
  end loop;

  return jsonb_build_object(
    'search_index_deleted', search_deleted,
    'calendar_talk_deleted', calendar_deleted,
    'room_tables_deleted', room_deleted
  );
end;
$$;

-- one-time cleanup on migration apply
select public.purge_line_search_control_messages();

