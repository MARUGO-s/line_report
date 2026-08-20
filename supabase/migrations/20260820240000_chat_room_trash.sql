-- ルーム完全削除の前にゴミ箱へ入れる。復元できる。店舗固定ルームは対象外。

alter table public.chat_groups
  add column if not exists trashed_at timestamptz,
  add column if not exists trashed_by uuid;

comment on column public.chat_groups.trashed_at is
  'ゴミ箱へ入れた時刻。null なら通常ルーム。';
comment on column public.chat_groups.trashed_by is
  'ゴミ箱へ入れたユーザー。作成者のみ。';

create index if not exists chat_groups_trashed_at_idx
  on public.chat_groups (trashed_at desc)
  where trashed_at is not null;

create or replace function public.chat_protect_trash_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if tg_op = 'UPDATE'
    and (
      new.trashed_at is distinct from old.trashed_at
      or new.trashed_by is distinct from old.trashed_by
    )
    and current_setting('chat.allow_trash', true) is distinct from '1'
  then
    raise exception 'ゴミ箱の操作は専用の操作から行ってください';
  end if;
  return new;
end;
$fn$;

drop trigger if exists chat_groups_protect_trash_columns on public.chat_groups;
create trigger chat_groups_protect_trash_columns
before update on public.chat_groups
for each row execute function public.chat_protect_trash_columns();

create or replace function public.chat_reject_trashed_group_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if exists (
    select 1 from public.chat_groups
    where id = new.group_id
      and trashed_at is not null
  ) then
    raise exception 'ゴミ箱のルームには送信・参加できません';
  end if;
  return new;
end;
$fn$;

drop trigger if exists chat_messages_reject_trashed on public.chat_messages;
create trigger chat_messages_reject_trashed
before insert on public.chat_messages
for each row execute function public.chat_reject_trashed_group_write();

drop trigger if exists chat_members_reject_trashed on public.chat_group_members;
create trigger chat_members_reject_trashed
before insert on public.chat_group_members
for each row execute function public.chat_reject_trashed_group_write();

drop trigger if exists chat_scheduled_reject_trashed on public.chat_scheduled_messages;
create trigger chat_scheduled_reject_trashed
before insert on public.chat_scheduled_messages
for each row execute function public.chat_reject_trashed_group_write();

create or replace function public.chat_trash_group(p_group_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_owner uuid;
  v_store boolean;
  v_trashed timestamptz;
begin
  if auth.uid() is null then
    raise exception 'ログインしてください';
  end if;

  select created_by, coalesce(is_store_room, false), trashed_at
    into v_owner, v_store, v_trashed
  from public.chat_groups
  where id = p_group_id;

  if v_owner is null then
    raise exception 'ルームが見つかりません';
  end if;
  if v_store then
    raise exception '店舗固定ルームは削除できません';
  end if;
  if v_owner is distinct from auth.uid() then
    raise exception 'ゴミ箱へ移せるのは作成者だけです';
  end if;
  if v_trashed is not null then
    return;
  end if;

  perform set_config('chat.allow_trash', '1', true);
  update public.chat_groups
  set trashed_at = now(),
      trashed_by = auth.uid()
  where id = p_group_id
    and created_by = auth.uid()
    and coalesce(is_store_room, false) = false;
end;
$fn$;

create or replace function public.chat_restore_group(p_group_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_owner uuid;
  v_store boolean;
  v_trashed timestamptz;
begin
  if auth.uid() is null then
    raise exception 'ログインしてください';
  end if;

  select created_by, coalesce(is_store_room, false), trashed_at
    into v_owner, v_store, v_trashed
  from public.chat_groups
  where id = p_group_id;

  if v_owner is null then
    raise exception 'ルームが見つかりません';
  end if;
  if v_store then
    raise exception '店舗固定ルームは削除できません';
  end if;
  if v_owner is distinct from auth.uid() then
    raise exception '復元できるのは作成者だけです';
  end if;
  if v_trashed is null then
    return;
  end if;

  perform set_config('chat.allow_trash', '1', true);
  update public.chat_groups
  set trashed_at = null,
      trashed_by = null
  where id = p_group_id
    and created_by = auth.uid();
end;
$fn$;

revoke all on function public.chat_protect_trash_columns() from public, anon, authenticated;
revoke all on function public.chat_reject_trashed_group_write() from public, anon, authenticated;
revoke all on function public.chat_trash_group(bigint) from public, anon;
revoke all on function public.chat_restore_group(bigint) from public, anon;
grant execute on function public.chat_trash_group(bigint) to authenticated;
grant execute on function public.chat_restore_group(bigint) to authenticated;

alter table public.line_room_dismissed
  add column if not exists previous_store_partition_key text;

comment on column public.line_room_dismissed.previous_store_partition_key is
  'ゴミ箱へ移す直前の店舗キー。復元時に戻す。';
comment on table public.line_room_dismissed is
  '管理画面のルームゴミ箱。保存データは保持し、get_room_overview から除外する。完全削除の前に入れる。';
