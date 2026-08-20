-- 指定ルーム専用のメッセージ分割表だけを DROP する。
-- 表名は line_messages__r + md5(room_id) 先頭16桁に一致する場合だけ。他ルームの表は触れない。

create or replace function public.drop_line_room_message_table(p_room_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected text;
  v_actual text;
begin
  if not public.is_valid_line_room_id(p_room_id) then
    raise exception 'invalid room_id';
  end if;

  v_expected := public.line_room_message_table_name(p_room_id);
  if v_expected is null or v_expected !~ '^line_messages__r[0-9a-f]{16}$' then
    raise exception 'invalid message table name';
  end if;

  select message_table into v_actual
  from public.line_room_message_tables
  where room_id = p_room_id;

  if v_actual is null then
    return null;
  end if;
  if v_actual is distinct from v_expected then
    raise exception 'message table name mismatch';
  end if;

  execute format('drop table if exists public.%I', v_expected);
  delete from public.line_room_message_tables
  where room_id = p_room_id
    and message_table = v_expected;
  return v_expected;
end;
$$;

comment on function public.drop_line_room_message_table(text) is
  '指定 room_id の分割メッセージ表だけを DROP する。他ルームの表名とは一致しない。';

revoke all on function public.drop_line_room_message_table(text) from public, anon, authenticated;
grant execute on function public.drop_line_room_message_table(text) to service_role;
