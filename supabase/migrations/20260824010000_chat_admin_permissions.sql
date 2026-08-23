-- M-talk (public/chat.html) 専用の利用可否とルーム別権限。
-- LINE側の line_user_permissions や一般管理画面の権限には影響させない。

-- ---------------------------------------------------------------------------
-- 1. チャット全体の利用可否
-- ---------------------------------------------------------------------------

create table if not exists public.chat_user_access (
  user_id uuid primary key references public.chat_users(id) on delete cascade,
  access_enabled boolean not null default true,
  can_start_direct boolean not null default true,
  can_create_group boolean not null default true,
  can_browse_users boolean not null default true,
  restriction_reason text,
  restricted_until timestamptz,
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint chat_user_access_reason_length check (
    restriction_reason is null or char_length(restriction_reason) <= 500
  ),
  constraint chat_user_access_updated_by_length check (
    updated_by is null or char_length(updated_by) <= 200
  )
);

comment on table public.chat_user_access is
  'M-talkだけに適用するユーザー利用可否。auth.usersやLINE権限は変更しない。';
comment on column public.chat_user_access.restricted_until is
  '未来時刻ならその時刻までM-talkを停止する。過去時刻は停止解除済みとして扱う。';
comment on column public.chat_user_access.deleted_at is
  'M-talk上の論理削除日時。auth.users/chat_users/履歴は物理削除しない。';

insert into public.chat_user_access (user_id)
select cu.id from public.chat_users cu
on conflict (user_id) do nothing;

create or replace function public.chat_create_default_user_access()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.chat_user_access (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$fn$;

drop trigger if exists chat_users_create_default_access on public.chat_users;
create trigger chat_users_create_default_access
after insert on public.chat_users
for each row execute function public.chat_create_default_user_access();

alter table public.chat_user_access enable row level security;
revoke all on table public.chat_user_access from public, anon, authenticated;
grant select on table public.chat_user_access to authenticated;
grant select, insert, update, delete on table public.chat_user_access to service_role;

drop policy if exists chat_user_access_select_self on public.chat_user_access;
create policy chat_user_access_select_self on public.chat_user_access
  for select to authenticated
  using (user_id = (select auth.uid()));

-- 利用停止を開いているchat.htmlへ即時通知できるよう、本人行だけRealtime配信する。
do $publication$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'chat_user_access'
  ) then
    alter publication supabase_realtime add table public.chat_user_access;
  end if;
end
$publication$;

-- ---------------------------------------------------------------------------
-- 2. ルーム参加者ごとの権限
-- ---------------------------------------------------------------------------

alter table public.chat_group_members
  add column if not exists can_view boolean not null default true,
  add column if not exists can_send boolean not null default true,
  add column if not exists can_invite boolean not null default true,
  add column if not exists can_manage boolean not null default false;

-- 既存動作を維持しつつ、作成者だけを管理可能にする。
update public.chat_group_members gm
set can_view = true,
    can_send = true,
    can_invite = case when coalesce(g.is_direct, false) then false else true end,
    can_manage = case
      when coalesce(g.is_direct, false) then false
      else g.created_by = gm.user_id
    end
from public.chat_groups g
where g.id = gm.group_id;

do $permission_constraint$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.chat_group_members'::regclass
      and conname = 'chat_group_members_view_required'
  ) then
    alter table public.chat_group_members
      add constraint chat_group_members_view_required check (
        can_view = true
        or (
          can_send = false
          and can_invite = false
          and can_manage = false
        )
      );
  end if;
end
$permission_constraint$;

comment on column public.chat_group_members.can_view is 'この参加者がルームと参加後の履歴を閲覧できる。';
comment on column public.chat_group_members.can_send is 'この参加者が通常投稿・画像・リアクション・予約送信を行える。';
comment on column public.chat_group_members.can_invite is 'この参加者が通常ルームへ他ユーザーを招待できる。1対1は常にfalse。';
comment on column public.chat_group_members.can_manage is 'この参加者が通常ルームの設定・メンバー・ゴミ箱を管理できる。1対1は常にfalse。';

-- クライアントが通常のUPDATEで自分の権限を昇格できないようにする。
create or replace function public.chat_protect_member_permissions()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_is_direct boolean;
begin
  select coalesce(g.is_direct, false)
    into v_is_direct
  from public.chat_groups g
  where g.id = new.group_id;

  if v_is_direct and (new.can_invite = true or new.can_manage = true) then
    raise exception '1対1トークでは招待・管理権限を付与できません';
  end if;

  if tg_op = 'UPDATE' then
    if auth.uid() is not null and (
      new.can_view is distinct from old.can_view
      or new.can_send is distinct from old.can_send
      or new.can_invite is distinct from old.can_invite
      or new.can_manage is distinct from old.can_manage
    ) then
      raise exception 'ルーム権限は管理画面または専用操作から変更してください';
    end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists chat_group_members_protect_permissions on public.chat_group_members;
create trigger chat_group_members_protect_permissions
before insert or update on public.chat_group_members
for each row execute function public.chat_protect_member_permissions();

-- 一般メンバーがUPDATEポリシー経由でルーム種別・所有者・店舗紐付けを変えないようにする。
create or replace function public.chat_protect_group_security_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is not null and (
    new.id is distinct from old.id
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
    or new.is_direct is distinct from old.is_direct
    or new.direct_key is distinct from old.direct_key
    or new.store_key is distinct from old.store_key
    or new.is_store_room is distinct from old.is_store_room
  ) then
    raise exception 'ルームのシステム項目は変更できません';
  end if;

  if auth.uid() is not null
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

drop trigger if exists chat_groups_protect_security_columns on public.chat_groups;
create trigger chat_groups_protect_security_columns
before update on public.chat_groups
for each row execute function public.chat_protect_group_security_columns();

-- ---------------------------------------------------------------------------
-- 3. 管理操作の監査
-- ---------------------------------------------------------------------------

create table if not exists public.chat_admin_audit_log (
  id bigint primary key generated always as identity,
  action text not null,
  target_user_id uuid,
  group_id bigint,
  actor text not null,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now(),
  constraint chat_admin_audit_action_length check (char_length(action) between 1 and 100),
  constraint chat_admin_audit_actor_length check (char_length(actor) between 1 and 200)
);

create index if not exists chat_admin_audit_created_idx
  on public.chat_admin_audit_log (created_at desc, id desc);
create index if not exists chat_admin_audit_target_idx
  on public.chat_admin_audit_log (target_user_id, created_at desc);
create index if not exists chat_admin_audit_group_idx
  on public.chat_admin_audit_log (group_id, created_at desc);

alter table public.chat_admin_audit_log enable row level security;
revoke all on table public.chat_admin_audit_log from public, anon, authenticated;
grant select, insert on table public.chat_admin_audit_log to service_role;

comment on table public.chat_admin_audit_log is
  'M-talk管理画面による利用停止・論理削除・ルーム権限変更の監査履歴。公開Data APIからは参照不可。';

-- ---------------------------------------------------------------------------
-- 4. 権限判定helper
-- ---------------------------------------------------------------------------

create or replace function public.chat_has_active_access(
  p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from public.chat_user_access a
    where a.user_id = p_user_id
      and a.access_enabled = true
      and a.deleted_at is null
      and (a.restricted_until is null or a.restricted_until <= now())
  )
$fn$;

create or replace function public.chat_is_registered()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from public.chat_users u
    where u.id = auth.uid()
  ) and public.chat_has_active_access()
$fn$;

create or replace function public.chat_can_browse_users()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from public.chat_user_access a
    where a.user_id = auth.uid()
      and a.access_enabled = true
      and a.can_browse_users = true
      and a.deleted_at is null
      and (a.restricted_until is null or a.restricted_until <= now())
  )
$fn$;

create or replace function public.chat_can_see_directory_user(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select public.chat_has_active_access(p_user_id)
    and (
      public.chat_can_browse_users()
      or (
        public.chat_has_active_access()
        and exists (
          select 1
          from public.chat_group_members mine
          join public.chat_group_members theirs
            on theirs.group_id = mine.group_id
           and theirs.user_id = p_user_id
           and theirs.can_view = true
          where mine.user_id = auth.uid()
            and mine.can_view = true
        )
      )
    )
$fn$;

create or replace function public.chat_can_view_group(p_group_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select public.chat_has_active_access() and exists (
    select 1
    from public.chat_group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = auth.uid()
      and gm.can_view = true
  )
$fn$;

-- 既存呼び出しとの互換性を保ち、member判定を「有効かつ閲覧可」に強化する。
create or replace function public.chat_is_member(p_group_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select public.chat_can_view_group(p_group_id)
$fn$;

create or replace function public.chat_can_send_group(p_group_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select public.chat_has_active_access() and exists (
    select 1
    from public.chat_group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = auth.uid()
      and gm.can_view = true
      and gm.can_send = true
  )
$fn$;

create or replace function public.chat_can_invite_group(p_group_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select public.chat_has_active_access() and exists (
    select 1
    from public.chat_group_members gm
    join public.chat_groups g on g.id = gm.group_id
    where gm.group_id = p_group_id
      and gm.user_id = auth.uid()
      and gm.can_view = true
      and gm.can_invite = true
      and not coalesce(g.is_direct, false)
  )
$fn$;

create or replace function public.chat_can_manage_group(p_group_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select public.chat_has_active_access() and exists (
    select 1
    from public.chat_group_members gm
    join public.chat_groups g on g.id = gm.group_id
    where gm.group_id = p_group_id
      and gm.user_id = auth.uid()
      and gm.can_view = true
      and gm.can_manage = true
      and not coalesce(g.is_direct, false)
  )
$fn$;

create or replace function public.chat_can_read_message(
  p_group_id bigint,
  p_created_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select public.chat_has_active_access() and exists (
    select 1
    from public.chat_group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = auth.uid()
      and gm.can_view = true
      and p_created_at >= gm.joined_at
  )
$fn$;

create or replace function public.chat_is_member_of_message(p_message_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select public.chat_has_active_access() and exists (
    select 1
    from public.chat_messages m
    join public.chat_group_members gm
      on gm.group_id = m.group_id
     and gm.user_id = auth.uid()
     and gm.can_view = true
     and m.created_at >= gm.joined_at
    where m.id = p_message_id
  )
$fn$;

create or replace function public.chat_can_interact_with_message(p_message_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select public.chat_has_active_access() and exists (
    select 1
    from public.chat_messages m
    join public.chat_group_members gm
      on gm.group_id = m.group_id
     and gm.user_id = auth.uid()
     and gm.can_view = true
     and gm.can_send = true
     and m.created_at >= gm.joined_at
    where m.id = p_message_id
  )
$fn$;

create or replace function public.chat_unread_counts()
returns table (group_id bigint, unread_count bigint)
language sql
stable
security definer
set search_path = public
as $fn$
  select m.group_id, count(*)::bigint
  from public.chat_messages m
  join public.chat_group_members gm
    on gm.group_id = m.group_id
   and gm.user_id = auth.uid()
   and gm.can_view
   and m.created_at >= gm.joined_at
  join public.chat_user_access a
    on a.user_id = gm.user_id
   and a.access_enabled
   and a.deleted_at is null
   and (a.restricted_until is null or a.restricted_until <= now())
  left join public.chat_read_states rs
    on rs.group_id = m.group_id and rs.user_id = auth.uid()
  where m.user_id <> auth.uid()
    and (rs.last_read_at is null or m.created_at > rs.last_read_at)
  group by m.group_id
$fn$;

create or replace function public.chat_push_unread_totals(p_user_ids uuid[])
returns table (user_id uuid, unread_count bigint)
language sql
stable
security definer
set search_path = public
as $fn$
  with recipients as (
    select distinct value as user_id
    from unnest(coalesce(p_user_ids, array[]::uuid[])) as ids(value)
    where value is not null
  )
  select recipients.user_id,
         count(m.id)::bigint as unread_count
  from recipients
  join public.chat_user_access a
    on a.user_id = recipients.user_id
   and a.access_enabled
   and a.deleted_at is null
   and (a.restricted_until is null or a.restricted_until <= now())
  left join public.chat_group_members gm
    on gm.user_id = recipients.user_id
   and gm.can_view
  left join public.chat_read_states rs
    on rs.group_id = gm.group_id
   and rs.user_id = recipients.user_id
  left join public.chat_messages m
    on m.group_id = gm.group_id
   and m.created_at >= gm.joined_at
   and m.user_id <> recipients.user_id
   and (rs.last_read_at is null or m.created_at > rs.last_read_at)
  group by recipients.user_id
$fn$;

revoke all on function public.chat_has_active_access(uuid) from public, anon, authenticated;
revoke all on function public.chat_is_registered() from public, anon;
revoke all on function public.chat_can_browse_users() from public, anon;
revoke all on function public.chat_can_see_directory_user(uuid) from public, anon;
revoke all on function public.chat_can_view_group(bigint) from public, anon;
revoke all on function public.chat_is_member(bigint) from public, anon;
revoke all on function public.chat_can_send_group(bigint) from public, anon;
revoke all on function public.chat_can_invite_group(bigint) from public, anon;
revoke all on function public.chat_can_manage_group(bigint) from public, anon;
revoke all on function public.chat_can_read_message(bigint, timestamptz) from public, anon;
revoke all on function public.chat_is_member_of_message(bigint) from public, anon;
revoke all on function public.chat_can_interact_with_message(bigint) from public, anon;
revoke all on function public.chat_unread_counts() from public, anon;
revoke all on function public.chat_push_unread_totals(uuid[]) from public, anon, authenticated;

grant execute on function public.chat_has_active_access(uuid) to service_role;
grant execute on function public.chat_is_registered() to authenticated, service_role;
grant execute on function public.chat_can_browse_users() to authenticated, service_role;
grant execute on function public.chat_can_see_directory_user(uuid) to authenticated, service_role;
grant execute on function public.chat_can_view_group(bigint) to authenticated, service_role;
grant execute on function public.chat_is_member(bigint) to authenticated, service_role;
grant execute on function public.chat_can_send_group(bigint) to authenticated, service_role;
grant execute on function public.chat_can_invite_group(bigint) to authenticated, service_role;
grant execute on function public.chat_can_manage_group(bigint) to authenticated, service_role;
grant execute on function public.chat_can_read_message(bigint, timestamptz) to authenticated, service_role;
grant execute on function public.chat_is_member_of_message(bigint) to authenticated, service_role;
grant execute on function public.chat_can_interact_with_message(bigint) to authenticated, service_role;
grant execute on function public.chat_unread_counts() to authenticated, service_role;
grant execute on function public.chat_push_unread_totals(uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 5. RLSを権限列へ統一
-- ---------------------------------------------------------------------------

drop policy if exists chat_users_select_self on public.chat_users;
drop policy if exists chat_users_select_registered on public.chat_users;
drop policy if exists chat_users_insert_self on public.chat_users;
drop policy if exists chat_users_update_self on public.chat_users;

create policy chat_users_select_self on public.chat_users
  for select to authenticated using (id = (select auth.uid()));
create policy chat_users_select_registered on public.chat_users
  for select to authenticated using (public.chat_can_see_directory_user(id));
create policy chat_users_insert_self on public.chat_users
  for insert to authenticated with check (id = (select auth.uid()));
create policy chat_users_update_self on public.chat_users
  for update to authenticated
  using (id = (select auth.uid()) and public.chat_is_registered())
  with check (id = (select auth.uid()) and public.chat_is_registered());

drop policy if exists chat_groups_select on public.chat_groups;
drop policy if exists chat_groups_insert on public.chat_groups;
drop policy if exists chat_groups_update_member on public.chat_groups;
drop policy if exists chat_groups_update_manager on public.chat_groups;

create policy chat_groups_select on public.chat_groups
  for select to authenticated using (public.chat_can_view_group(id));
create policy chat_groups_update_manager on public.chat_groups
  for update to authenticated
  using (public.chat_can_manage_group(id))
  with check (public.chat_can_manage_group(id));

drop policy if exists chat_group_members_select on public.chat_group_members;
drop policy if exists chat_group_members_insert_self on public.chat_group_members;
drop policy if exists chat_group_members_insert_by_member on public.chat_group_members;
drop policy if exists chat_group_members_delete_self on public.chat_group_members;

create policy chat_group_members_select on public.chat_group_members
  for select to authenticated
  using (
    (user_id = (select auth.uid()) and public.chat_is_registered())
    or (
      can_view = true
      and public.chat_can_view_group(group_id)
      and public.chat_can_see_directory_user(user_id)
    )
  );

-- 参加・追加・退出はすべて専用RPCへ限定する。authenticated向けINSERT/DELETE policyは作らない。

drop policy if exists chat_group_invites_member_all on public.chat_group_invites;
drop policy if exists chat_group_invites_inviter_select on public.chat_group_invites;
create policy chat_group_invites_member_all on public.chat_group_invites
  for select to authenticated using (public.chat_can_invite_group(group_id));

drop policy if exists chat_messages_select_member on public.chat_messages;
drop policy if exists chat_messages_select_since_join on public.chat_messages;
drop policy if exists chat_messages_insert_member on public.chat_messages;
drop policy if exists chat_messages_insert_sender on public.chat_messages;
drop policy if exists chat_messages_delete_own on public.chat_messages;

create policy chat_messages_select_since_join on public.chat_messages
  for select to authenticated
  using (public.chat_can_read_message(group_id, created_at));
create policy chat_messages_insert_member on public.chat_messages
  for insert to authenticated
  with check (
    public.chat_can_send_group(group_id)
    and user_id = (select auth.uid())
    and char_length(content) between 1 and 2000
  );
create policy chat_messages_delete_own on public.chat_messages
  for delete to authenticated
  using (user_id = (select auth.uid()) and public.chat_can_send_group(group_id));

drop policy if exists chat_read_states_own on public.chat_read_states;
drop policy if exists chat_read_states_select_member on public.chat_read_states;
drop policy if exists chat_read_states_insert_self on public.chat_read_states;
drop policy if exists chat_read_states_update_self on public.chat_read_states;
drop policy if exists chat_read_states_delete_self on public.chat_read_states;

create policy chat_read_states_select_member on public.chat_read_states
  for select to authenticated
  using (
    public.chat_can_view_group(group_id)
    and (
      user_id = (select auth.uid())
      or public.chat_can_see_directory_user(user_id)
    )
  );
create policy chat_read_states_insert_self on public.chat_read_states
  for insert to authenticated
  with check (user_id = (select auth.uid()) and public.chat_can_view_group(group_id));
create policy chat_read_states_update_self on public.chat_read_states
  for update to authenticated
  using (user_id = (select auth.uid()) and public.chat_can_view_group(group_id))
  with check (user_id = (select auth.uid()) and public.chat_can_view_group(group_id));
create policy chat_read_states_delete_self on public.chat_read_states
  for delete to authenticated
  using (user_id = (select auth.uid()) and public.chat_can_view_group(group_id));

drop policy if exists chat_reactions_select_member on public.chat_message_reactions;
drop policy if exists chat_reactions_insert_self on public.chat_message_reactions;
drop policy if exists chat_reactions_update_self on public.chat_message_reactions;
drop policy if exists chat_reactions_delete_self on public.chat_message_reactions;

create policy chat_reactions_select_member on public.chat_message_reactions
  for select to authenticated using (public.chat_is_member_of_message(message_id));
create policy chat_reactions_insert_self on public.chat_message_reactions
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and public.chat_can_interact_with_message(message_id)
    and char_length(emoji) between 1 and 16
  );
create policy chat_reactions_update_self on public.chat_message_reactions
  for update to authenticated
  using (
    user_id = (select auth.uid())
    and public.chat_can_interact_with_message(message_id)
  )
  with check (
    user_id = (select auth.uid())
    and public.chat_can_interact_with_message(message_id)
    and char_length(emoji) between 1 and 16
  );
create policy chat_reactions_delete_self on public.chat_message_reactions
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    and public.chat_can_interact_with_message(message_id)
  );

drop policy if exists chat_scheduled_messages_select_own on public.chat_scheduled_messages;
create policy chat_scheduled_messages_select_own on public.chat_scheduled_messages
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and public.chat_can_view_group(group_id)
  );

drop policy if exists chat_push_user_preferences_select_self on public.chat_push_user_preferences;
create policy chat_push_user_preferences_select_self on public.chat_push_user_preferences
  for select to authenticated
  using (user_id = (select auth.uid()) and public.chat_is_registered());

drop policy if exists chat_stickers_select_authenticated on public.chat_stickers;
create policy chat_stickers_select_authenticated on public.chat_stickers
  for select to authenticated
  using (is_active and public.chat_is_registered());

-- ---------------------------------------------------------------------------
-- 6. Storage権限
-- ---------------------------------------------------------------------------

create or replace function public.chat_can_view_path(p_folder text)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select case
    when p_folder ~ '^[0-9]+$' then public.chat_can_view_group(p_folder::bigint)
    else false
  end
$fn$;

-- 旧helper名を残し、既存クライアントや過去のStorage policyとの互換性を保つ。
create or replace function public.chat_is_member_path(p_folder text)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select public.chat_can_view_path(p_folder)
$fn$;

create or replace function public.chat_can_send_path(p_folder text)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select case
    when p_folder ~ '^[0-9]+$' then public.chat_can_send_group(p_folder::bigint)
    else false
  end
$fn$;

create or replace function public.chat_can_manage_path(p_folder text)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select case
    when p_folder ~ '^[0-9]+$' then public.chat_can_manage_group(p_folder::bigint)
    else false
  end
$fn$;

revoke all on function public.chat_can_view_path(text) from public, anon;
revoke all on function public.chat_is_member_path(text) from public, anon;
revoke all on function public.chat_can_send_path(text) from public, anon;
revoke all on function public.chat_can_manage_path(text) from public, anon;
grant execute on function public.chat_can_view_path(text) to authenticated, service_role;
grant execute on function public.chat_is_member_path(text) to authenticated, service_role;
grant execute on function public.chat_can_send_path(text) to authenticated, service_role;
grant execute on function public.chat_can_manage_path(text) to authenticated, service_role;

drop policy if exists chat_icons_select on storage.objects;
drop policy if exists chat_icons_insert on storage.objects;
drop policy if exists chat_icons_update on storage.objects;
drop policy if exists chat_icons_delete on storage.objects;

-- chat-iconsは既存URL互換の公開バケットなので閲覧は維持し、書込先だけを厳格化する。
create policy chat_icons_select on storage.objects
  for select to public using (bucket_id = 'chat-icons');
create policy chat_icons_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'chat-icons'
    and (
      (
        (storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = (select auth.uid())::text
        and public.chat_is_registered()
      )
      or (
        (storage.foldername(name))[1] = 'groups'
        and public.chat_can_manage_path((storage.foldername(name))[2])
      )
    )
  );
create policy chat_icons_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'chat-icons'
    and (
      (
        (storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = (select auth.uid())::text
        and public.chat_is_registered()
      )
      or (
        (storage.foldername(name))[1] = 'groups'
        and public.chat_can_manage_path((storage.foldername(name))[2])
      )
    )
  )
  with check (
    bucket_id = 'chat-icons'
    and (
      (
        (storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = (select auth.uid())::text
        and public.chat_is_registered()
      )
      or (
        (storage.foldername(name))[1] = 'groups'
        and public.chat_can_manage_path((storage.foldername(name))[2])
      )
    )
  );
create policy chat_icons_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'chat-icons'
    and (
      (
        (storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = (select auth.uid())::text
        and public.chat_is_registered()
      )
      or (
        (storage.foldername(name))[1] = 'groups'
        and public.chat_can_manage_path((storage.foldername(name))[2])
      )
    )
  );

drop policy if exists chat_images_select on storage.objects;
drop policy if exists chat_images_insert on storage.objects;
drop policy if exists chat_images_update on storage.objects;
drop policy if exists chat_images_delete on storage.objects;

create policy chat_images_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'chat-images'
    and (storage.foldername(name))[1] = 'groups'
    and public.chat_can_view_path((storage.foldername(name))[2])
  );
create policy chat_images_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'chat-images'
    and (storage.foldername(name))[1] = 'groups'
    and public.chat_can_send_path((storage.foldername(name))[2])
  );

-- ---------------------------------------------------------------------------
-- 7. ルーム作成・参加・招待・1対1 RPC
-- ---------------------------------------------------------------------------

create or replace function public.chat_create_group(
  p_group_name text,
  p_member_ids uuid[] default '{}'
)
returns bigint
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_me uuid := auth.uid();
  v_group_id bigint;
  v_name text := btrim(coalesce(p_group_name, ''));
begin
  if v_me is null or not public.chat_is_registered() then
    raise exception 'ログインしてください';
  end if;
  if not exists (
    select 1 from public.chat_user_access a
    where a.user_id = v_me and a.can_create_group
  ) then
    raise exception 'グループを作成する権限がありません';
  end if;
  if v_name = '' or char_length(v_name) > 120 then
    raise exception 'グループ名は1〜120文字で入力してください';
  end if;
  if exists (
    select 1
    from unnest(coalesce(p_member_ids, '{}'::uuid[])) ids(user_id)
    where ids.user_id is null
       or not public.chat_has_active_access(ids.user_id)
  ) then
    raise exception '招待できないユーザーが含まれています';
  end if;

  insert into public.chat_groups (group_name, created_by, is_direct, direct_key)
  values (v_name, v_me, false, null)
  returning id into v_group_id;

  insert into public.chat_group_members (
    group_id, user_id, can_view, can_send, can_invite, can_manage
  ) values (
    v_group_id, v_me, true, true, true, true
  );

  insert into public.chat_group_members (
    group_id, user_id, can_view, can_send, can_invite, can_manage
  )
  select v_group_id, ids.user_id, true, true, true, false
  from (
    select distinct user_id
    from unnest(coalesce(p_member_ids, '{}'::uuid[])) members(user_id)
    where user_id is not null and user_id <> v_me
  ) ids
  on conflict (group_id, user_id) do nothing;

  return v_group_id;
end;
$fn$;

create or replace function public.chat_add_members(
  p_group_id bigint,
  p_user_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_direct boolean;
begin
  if auth.uid() is null or not public.chat_can_invite_group(p_group_id) then
    raise exception 'このルームへ招待する権限がありません';
  end if;
  select coalesce(is_direct, false) into v_direct
  from public.chat_groups where id = p_group_id;
  if not found then raise exception 'ルームが見つかりません'; end if;
  if v_direct then raise exception '1対1トークには追加できません'; end if;

  if exists (
    select 1
    from unnest(coalesce(p_user_ids, '{}'::uuid[])) ids(user_id)
    where ids.user_id is null
       or not public.chat_has_active_access(ids.user_id)
  ) then
    raise exception '招待できないユーザーが含まれています';
  end if;

  insert into public.chat_group_members (
    group_id, user_id, can_view, can_send, can_invite, can_manage
  )
  select p_group_id, ids.user_id, true, true, true, false
  from (
    select distinct user_id
    from unnest(coalesce(p_user_ids, '{}'::uuid[])) members(user_id)
    where user_id is not null
  ) ids
  on conflict (group_id, user_id) do nothing;
end;
$fn$;

create or replace function public.chat_leave_group(p_group_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_is_direct boolean;
  v_is_store_room boolean;
  v_created_by uuid;
begin
  if auth.uid() is null or not public.chat_can_view_group(p_group_id) then
    raise exception 'このルームから退出する権限がありません';
  end if;

  select coalesce(is_direct, false), coalesce(is_store_room, false), created_by
    into v_is_direct, v_is_store_room, v_created_by
  from public.chat_groups
  where id = p_group_id;
  if not found then raise exception 'ルームが見つかりません'; end if;
  if v_is_direct then raise exception '1対1トークからは退出できません'; end if;
  if v_is_store_room then raise exception '店舗固定ルームは退出できません'; end if;
  if v_created_by = auth.uid() and not exists (
    select 1
    from public.chat_group_members gm
    where gm.group_id = p_group_id
      and gm.user_id <> auth.uid()
      and gm.can_view = true
      and gm.can_manage = true
  ) then
    raise exception '管理権限を別の参加者へ付与してから退出してください';
  end if;

  delete from public.chat_group_members
  where group_id = p_group_id and user_id = auth.uid();
  if not found then raise exception 'このルームに参加していません'; end if;
end;
$fn$;

create or replace function public.chat_open_direct(p_other uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_me uuid := auth.uid();
  v_key text;
  v_id bigint;
  v_name text;
begin
  if v_me is null or not public.chat_is_registered() then
    raise exception 'ログインが必要です';
  end if;
  if not exists (
    select 1 from public.chat_user_access a
    where a.user_id = v_me and a.can_start_direct
  ) then
    raise exception '1対1トークを開始する権限がありません';
  end if;
  if p_other is null or p_other = v_me then
    raise exception '自分以外のユーザーを選んでください';
  end if;
  if not public.chat_has_active_access(p_other) then
    raise exception '相手のユーザーは現在利用できません';
  end if;

  if v_me::text < p_other::text then
    v_key := v_me::text || ':' || p_other::text;
  else
    v_key := p_other::text || ':' || v_me::text;
  end if;

  select id into v_id
  from public.chat_groups
  where direct_key = v_key and is_direct;

  if v_id is null then
    select string_agg(username, '・' order by username) into v_name
    from public.chat_users where id in (v_me, p_other);

    insert into public.chat_groups (group_name, created_by, is_direct, direct_key)
    values (coalesce(v_name, '友だち'), v_me, true, v_key)
    returning id into v_id;
  elsif exists (
    select 1 from public.chat_group_members
    where group_id = v_id and user_id not in (v_me, p_other)
  ) then
    raise exception '1対1トークの参加者が不正です';
  end if;

  insert into public.chat_group_members (
    group_id, user_id, can_view, can_send, can_invite, can_manage
  ) values
    (v_id, v_me, true, true, false, false),
    (v_id, p_other, true, true, false, false)
  on conflict (group_id, user_id) do nothing;

  if exists (
    select 1 from public.chat_group_members
    where group_id = v_id
      and user_id in (v_me, p_other)
      and not can_view
  ) then
    raise exception 'この1対1トークへのアクセスは制限されています';
  end if;
  if (select count(*) from public.chat_group_members where group_id = v_id) <> 2 then
    raise exception '1対1トークには2人だけ参加できます';
  end if;

  return v_id;
end;
$fn$;

create or replace function public.chat_ensure_invite(p_group_id bigint)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_token text;
begin
  if auth.uid() is null or not public.chat_can_invite_group(p_group_id) then
    raise exception 'このグループを招待する権限がありません';
  end if;
  if exists (select 1 from public.chat_groups where id = p_group_id and is_direct) then
    raise exception '1対1トークの招待リンクは作れません';
  end if;

  select token into v_token
  from public.chat_group_invites where group_id = p_group_id;
  if v_token is null then
    insert into public.chat_group_invites (group_id, created_by)
    values (p_group_id, auth.uid())
    returning token into v_token;
  end if;
  return v_token;
end;
$fn$;

create or replace function public.chat_rotate_invite(p_group_id bigint)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null or not public.chat_can_invite_group(p_group_id) then
    raise exception 'このグループを招待する権限がありません';
  end if;
  if exists (select 1 from public.chat_groups where id = p_group_id and is_direct) then
    raise exception '1対1トークの招待リンクは作れません';
  end if;
  delete from public.chat_group_invites where group_id = p_group_id;
  return public.chat_ensure_invite(p_group_id);
end;
$fn$;

create or replace function public.chat_join_by_invite(p_token text)
returns bigint
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_group_id bigint;
  v_existing boolean;
begin
  if auth.uid() is null or not public.chat_is_registered() then
    raise exception 'ログインが必要です';
  end if;
  select i.group_id into v_group_id
  from public.chat_group_invites i
  join public.chat_groups g on g.id = i.group_id and not g.is_direct
  where i.token = p_token;
  if v_group_id is null then raise exception '招待リンクが無効です'; end if;

  select exists (
    select 1 from public.chat_group_members
    where group_id = v_group_id and user_id = auth.uid()
  ) into v_existing;
  if v_existing then
    if not exists (
      select 1 from public.chat_group_members
      where group_id = v_group_id and user_id = auth.uid() and can_view
    ) then
      raise exception 'このルームへのアクセスは制限されています';
    end if;
    return v_group_id;
  end if;

  insert into public.chat_group_members (
    group_id, user_id, can_view, can_send, can_invite, can_manage
  ) values (
    v_group_id, auth.uid(), true, true, true, false
  );
  return v_group_id;
end;
$fn$;

create or replace function public.chat_kick_member(p_group_id bigint, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_owner uuid;
  v_direct boolean;
  v_store_room boolean;
  v_is_bot boolean;
  v_store_key text;
begin
  if auth.uid() is null or not public.chat_can_manage_group(p_group_id) then
    raise exception '退出させる権限がありません';
  end if;
  if p_user_id is null or p_user_id = auth.uid() then
    raise exception '退出させる相手を正しく指定してください';
  end if;

  select created_by, coalesce(is_direct, false), coalesce(is_store_room, false)
    into v_owner, v_direct, v_store_room
  from public.chat_groups where id = p_group_id;
  if v_owner is null then raise exception 'ルームが見つかりません'; end if;
  if v_direct then raise exception '1対1トークから退出させることはできません'; end if;
  if p_user_id = v_owner then raise exception 'ルーム作成者は退出させられません'; end if;

  select coalesce(is_bot, false), store_key into v_is_bot, v_store_key
  from public.chat_users where id = p_user_id;
  if p_user_id = '00000000-0000-4000-8000-00000000b071'::uuid
    or (v_is_bot and v_store_key is null)
  then
    raise exception 'このアカウントは退出させられません';
  end if;
  if v_is_bot and v_store_room then
    raise exception '店舗Botは店舗ルームから退出させられません';
  end if;

  delete from public.chat_group_members
  where group_id = p_group_id and user_id = p_user_id;
  if not found then raise exception 'このユーザーは参加していません'; end if;
end;
$fn$;

create or replace function public.chat_trash_group(p_group_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_store boolean;
  v_trashed timestamptz;
begin
  if auth.uid() is null or not public.chat_can_manage_group(p_group_id) then
    raise exception 'ゴミ箱へ移す権限がありません';
  end if;
  select coalesce(is_store_room, false), trashed_at into v_store, v_trashed
  from public.chat_groups where id = p_group_id;
  if not found then raise exception 'ルームが見つかりません'; end if;
  if v_store then raise exception '店舗固定ルームは削除できません'; end if;
  if v_trashed is not null then return; end if;

  perform set_config('chat.allow_trash', '1', true);
  update public.chat_groups
  set trashed_at = now(), trashed_by = auth.uid()
  where id = p_group_id and coalesce(is_store_room, false) = false;
end;
$fn$;

create or replace function public.chat_restore_group(p_group_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_store boolean;
  v_trashed timestamptz;
begin
  if auth.uid() is null or not public.chat_can_manage_group(p_group_id) then
    raise exception '復元する権限がありません';
  end if;
  select coalesce(is_store_room, false), trashed_at into v_store, v_trashed
  from public.chat_groups where id = p_group_id;
  if not found then raise exception 'ルームが見つかりません'; end if;
  if v_store then raise exception '店舗固定ルームは削除できません'; end if;
  if v_trashed is null then return; end if;

  perform set_config('chat.allow_trash', '1', true);
  update public.chat_groups
  set trashed_at = null, trashed_by = null
  where id = p_group_id;
end;
$fn$;

revoke all on function public.chat_create_group(text, uuid[]) from public, anon;
revoke all on function public.chat_add_members(bigint, uuid[]) from public, anon;
revoke all on function public.chat_leave_group(bigint) from public, anon;
revoke all on function public.chat_open_direct(uuid) from public, anon;
revoke all on function public.chat_ensure_invite(bigint) from public, anon;
revoke all on function public.chat_rotate_invite(bigint) from public, anon;
revoke all on function public.chat_join_by_invite(text) from public, anon;
revoke all on function public.chat_kick_member(bigint, uuid) from public, anon;
revoke all on function public.chat_trash_group(bigint) from public, anon;
revoke all on function public.chat_restore_group(bigint) from public, anon;

grant execute on function public.chat_create_group(text, uuid[]) to authenticated;
grant execute on function public.chat_add_members(bigint, uuid[]) to authenticated;
grant execute on function public.chat_leave_group(bigint) to authenticated;
grant execute on function public.chat_open_direct(uuid) to authenticated;
grant execute on function public.chat_ensure_invite(bigint) to authenticated;
grant execute on function public.chat_rotate_invite(bigint) to authenticated;
grant execute on function public.chat_join_by_invite(text) to authenticated;
grant execute on function public.chat_kick_member(bigint, uuid) to authenticated;
grant execute on function public.chat_trash_group(bigint) to authenticated;
grant execute on function public.chat_restore_group(bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. 予約送信（登録時と実送信時の両方でcan_sendを確認）
-- ---------------------------------------------------------------------------

create or replace function public.chat_schedule_message(
  p_group_id bigint,
  p_content text,
  p_send_at timestamptz,
  p_reply_to_id bigint default null,
  p_mentions uuid[] default '{}',
  p_kind text default 'text',
  p_payload jsonb default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_content text;
  v_kind text;
  v_path text;
  v_raw_w text;
  v_raw_h text;
  v_w integer;
  v_h integer;
  v_id bigint;
begin
  if auth.uid() is null or not public.chat_can_send_group(p_group_id) then
    raise exception 'このルームへ予約送信する権限がありません';
  end if;

  v_kind := coalesce(nullif(btrim(p_kind), ''), 'text');
  if v_kind not in ('text', 'image') then
    raise exception '予約できるメッセージ種別ではありません';
  end if;
  if p_send_at is null then raise exception '送信日時を指定してください'; end if;
  if p_send_at < clock_timestamp() + interval '30 seconds' then
    raise exception '送信日時は現在より後にしてください';
  end if;
  if p_send_at > clock_timestamp() + interval '365 days' then
    raise exception '送信日時は1年以内にしてください';
  end if;
  if p_reply_to_id is not null and not exists (
    select 1 from public.chat_messages
    where id = p_reply_to_id and group_id = p_group_id
      and public.chat_can_read_message(group_id, created_at)
  ) then
    raise exception '返信先の発言が同じトークルームにありません';
  end if;

  if v_kind = 'image' then
    v_path := nullif(p_payload #>> '{image,path}', '');
    if v_path is null or v_path not like 'groups/' || p_group_id::text || '/%' then
      raise exception '画像の保存先が不正です';
    end if;
    v_raw_w := p_payload #>> '{image,w}';
    v_raw_h := p_payload #>> '{image,h}';
    if coalesce(v_raw_w, '') ~ '^[1-9][0-9]{0,4}$' then v_w := v_raw_w::integer; end if;
    if coalesce(v_raw_h, '') ~ '^[1-9][0-9]{0,4}$' then v_h := v_raw_h::integer; end if;
    p_payload := jsonb_strip_nulls(jsonb_build_object(
      'v', 1,
      'kind', 'image',
      'image', jsonb_strip_nulls(jsonb_build_object('path', v_path, 'w', v_w, 'h', v_h))
    ));
    v_content := coalesce(nullif(btrim(p_content), ''), '[画像]');
  else
    v_content := btrim(coalesce(p_content, ''));
    if v_content = '' then raise exception 'メッセージを入力してください'; end if;
    p_payload := null;
  end if;
  if char_length(v_content) > 2000 then raise exception 'メッセージが長すぎます'; end if;

  if array_length(p_mentions, 1) is not null then
    select coalesce(array_agg(distinct gm.user_id), '{}'::uuid[])
      into p_mentions
    from public.chat_group_members gm
    where gm.group_id = p_group_id
      and gm.user_id = any(p_mentions);
  end if;

  insert into public.chat_scheduled_messages (
    group_id, user_id, content, kind, payload, reply_to_id, mentions, send_at
  ) values (
    p_group_id, auth.uid(), v_content, v_kind, p_payload,
    p_reply_to_id, coalesce(p_mentions, '{}'::uuid[]), p_send_at
  ) returning id into v_id;
  return v_id;
end;
$fn$;

create or replace function public.chat_cancel_scheduled_message(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null or not public.chat_has_active_access() then
    raise exception 'ログインしてください';
  end if;
  update public.chat_scheduled_messages
  set cancelled_at = clock_timestamp()
  where id = p_id
    and sent_at is null
    and cancelled_at is null
    and (
      (user_id = auth.uid() and public.chat_can_send_group(group_id))
      or public.chat_can_manage_group(group_id)
    );
  if not found then raise exception '取り消せる予約送信がありません'; end if;
end;
$fn$;

create or replace function public.chat_dispatch_scheduled_messages()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r record;
  v_username text;
  v_payload jsonb;
  v_path text;
  v_raw_w text;
  v_raw_h text;
  v_w integer;
  v_h integer;
  v_msg_id bigint;
  v_count integer := 0;
begin
  for r in
    select s.*
    from public.chat_scheduled_messages s
    where s.sent_at is null
      and s.cancelled_at is null
      and s.send_at <= clock_timestamp()
    order by s.send_at, s.id
    for update of s skip locked
    limit 50
  loop
    begin
      if not public.chat_has_active_access(r.user_id) or not exists (
        select 1
        from public.chat_group_members gm
        where gm.group_id = r.group_id
          and gm.user_id = r.user_id
          and gm.can_view = true
          and gm.can_send = true
      ) then
        update public.chat_scheduled_messages
        set cancelled_at = clock_timestamp(), error = '送信時点でルームの送信権限がありません'
        where id = r.id;
        continue;
      end if;

      select username into v_username from public.chat_users where id = r.user_id;
      if v_username is null then
        update public.chat_scheduled_messages
        set cancelled_at = clock_timestamp(), error = 'チャットのプロフィールがありません'
        where id = r.id;
        continue;
      end if;

      -- 予約登録時の検査に加え、旧予約行も含めて配信直前に画像payloadを再構築する。
      -- service_roleによるINSERTでは通常投稿のauthor triggerにauth.uid()が無いため、
      -- ここで正規化しないとw/h等の任意文字列をそのまま配信できてしまう。
      v_payload := null;
      v_path := null;
      v_raw_w := null;
      v_raw_h := null;
      v_w := null;
      v_h := null;
      if r.kind = 'image' then
        v_path := nullif(r.payload #>> '{image,path}', '');
        if v_path is null or v_path not like 'groups/' || r.group_id::text || '/%' then
          raise exception '画像の保存先が不正です';
        end if;
        v_raw_w := r.payload #>> '{image,w}';
        v_raw_h := r.payload #>> '{image,h}';
        if coalesce(v_raw_w, '') ~ '^[1-9][0-9]{0,4}$' then v_w := v_raw_w::integer; end if;
        if coalesce(v_raw_h, '') ~ '^[1-9][0-9]{0,4}$' then v_h := v_raw_h::integer; end if;
        v_payload := jsonb_strip_nulls(jsonb_build_object(
          'v', 1,
          'kind', 'image',
          'image', jsonb_strip_nulls(jsonb_build_object('path', v_path, 'w', v_w, 'h', v_h))
        ));
      end if;

      insert into public.chat_messages (
        group_id, user_id, username, content, kind, payload, reply_to_id, mentions
      ) values (
        r.group_id, r.user_id, v_username, r.content,
        case when r.kind in ('text', 'image') then r.kind else 'text' end,
        v_payload, r.reply_to_id, coalesce(r.mentions, '{}'::uuid[])
      ) returning id into v_msg_id;

      update public.chat_scheduled_messages
      set sent_at = clock_timestamp(), sent_message_id = v_msg_id, error = null
      where id = r.id;
      v_count := v_count + 1;
    exception
      when others then
        update public.chat_scheduled_messages
        set error = left(sqlerrm, 300)
        where id = r.id;
    end;
  end loop;
  return v_count;
end;
$fn$;

revoke all on function public.chat_schedule_message(bigint, text, timestamptz, bigint, uuid[], text, jsonb) from public, anon;
revoke all on function public.chat_cancel_scheduled_message(bigint) from public, anon;
revoke all on function public.chat_dispatch_scheduled_messages() from public, anon, authenticated;
grant execute on function public.chat_schedule_message(bigint, text, timestamptz, bigint, uuid[], text, jsonb) to authenticated;
grant execute on function public.chat_cancel_scheduled_message(bigint) to authenticated;
grant execute on function public.chat_dispatch_scheduled_messages() to service_role;

-- ---------------------------------------------------------------------------
-- 9. 管理画面専用RPC（service_roleのみ）
-- ---------------------------------------------------------------------------

create or replace function public.chat_admin_update_user_access(
  p_user_id uuid,
  p_access_enabled boolean,
  p_can_start_direct boolean,
  p_can_create_group boolean,
  p_can_browse_users boolean,
  p_restriction_reason text,
  p_restricted_until timestamptz,
  p_update_restriction_reason boolean,
  p_update_restricted_until boolean,
  p_expected_updated_at timestamptz,
  p_actor text
)
returns public.chat_user_access
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_before public.chat_user_access;
  v_after public.chat_user_access;
  v_is_bot boolean;
  v_actor text := left(coalesce(nullif(btrim(p_actor), ''), 'chat-admin'), 200);
begin
  select is_bot into v_is_bot from public.chat_users where id = p_user_id;
  if not found then raise exception 'ユーザーが見つかりません'; end if;
  if v_is_bot then raise exception 'Botの利用を停止・変更することはできません'; end if;

  insert into public.chat_user_access (user_id) values (p_user_id)
  on conflict (user_id) do nothing;
  select * into v_before from public.chat_user_access
  where user_id = p_user_id for update;
  if v_before.deleted_at is not null then
    raise exception '削除済みユーザーは復元操作を使用してください';
  end if;
  if p_expected_updated_at is null
    or v_before.updated_at is distinct from p_expected_updated_at
  then
    raise exception using
      errcode = '40001',
      message = '別の管理者が先に更新しました。再読み込みしてください';
  end if;

  update public.chat_user_access
  set access_enabled = coalesce(p_access_enabled, access_enabled),
      can_start_direct = coalesce(p_can_start_direct, can_start_direct),
      can_create_group = coalesce(p_can_create_group, can_create_group),
      can_browse_users = coalesce(p_can_browse_users, can_browse_users),
      restriction_reason = case
        when p_update_restriction_reason then nullif(btrim(coalesce(p_restriction_reason, '')), '')
        else restriction_reason
      end,
      restricted_until = case
        when p_update_restricted_until then p_restricted_until
        else restricted_until
      end,
      updated_at = clock_timestamp(),
      updated_by = v_actor
  where user_id = p_user_id
  returning * into v_after;

  insert into public.chat_admin_audit_log (
    action, target_user_id, actor, before_state, after_state
  ) values (
    'user_access_update', p_user_id, v_actor, to_jsonb(v_before), to_jsonb(v_after)
  );
  return v_after;
end;
$fn$;

create or replace function public.chat_admin_remove_user(
  p_user_id uuid,
  p_actor text,
  p_confirm_username text
)
returns public.chat_user_access
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_before public.chat_user_access;
  v_after public.chat_user_access;
  v_username text;
  v_is_bot boolean;
  v_actor text := left(coalesce(nullif(btrim(p_actor), ''), 'chat-admin'), 200);
begin
  select username, is_bot into v_username, v_is_bot
  from public.chat_users where id = p_user_id;
  if not found then raise exception 'ユーザーが見つかりません'; end if;
  if v_is_bot then raise exception 'Botは削除できません'; end if;
  if btrim(coalesce(p_confirm_username, '')) is distinct from v_username then
    raise exception '確認用のユーザー名が一致しません';
  end if;

  insert into public.chat_user_access (user_id) values (p_user_id)
  on conflict (user_id) do nothing;
  select * into v_before from public.chat_user_access
  where user_id = p_user_id for update;

  update public.chat_user_access
  set access_enabled = false,
      restriction_reason = '管理者によりM-talkアカウントを削除',
      restricted_until = null,
      deleted_at = coalesce(deleted_at, now()),
      updated_at = now(),
      updated_by = v_actor
  where user_id = p_user_id
  returning * into v_after;

  -- ルーム別の細粒度権限は保持する。chat_has_active_access() のglobal gateで
  -- 全ルームを即時遮断し、復元時も削除前の権限を正確に再利用する。

  update public.chat_scheduled_messages
  set cancelled_at = coalesce(cancelled_at, clock_timestamp()),
      error = coalesce(error, 'M-talkアカウント削除により取消')
  where user_id = p_user_id and sent_at is null and cancelled_at is null;

  update public.chat_push_subscriptions
  set is_active = false, updated_at = now()
  where user_id = p_user_id and is_active;

  update public.chat_push_user_preferences
  set notifications_enabled = false, updated_at = now()
  where user_id = p_user_id;

  insert into public.chat_admin_audit_log (
    action, target_user_id, actor, before_state, after_state
  ) values (
    'user_remove', p_user_id, v_actor, to_jsonb(v_before), to_jsonb(v_after)
  );
  return v_after;
end;
$fn$;

create or replace function public.chat_admin_restore_user(
  p_user_id uuid,
  p_actor text
)
returns public.chat_user_access
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_before public.chat_user_access;
  v_after public.chat_user_access;
  v_is_bot boolean;
  v_actor text := left(coalesce(nullif(btrim(p_actor), ''), 'chat-admin'), 200);
begin
  select is_bot into v_is_bot from public.chat_users where id = p_user_id;
  if not found then raise exception 'ユーザーが見つかりません'; end if;
  if v_is_bot then raise exception 'Botは復元操作の対象ではありません'; end if;

  insert into public.chat_user_access (user_id) values (p_user_id)
  on conflict (user_id) do nothing;
  select * into v_before from public.chat_user_access
  where user_id = p_user_id for update;

  update public.chat_user_access
  set access_enabled = true,
      restriction_reason = null,
      restricted_until = null,
      deleted_at = null,
      updated_at = now(),
      updated_by = v_actor
  where user_id = p_user_id
  returning * into v_after;

  insert into public.chat_admin_audit_log (
    action, target_user_id, actor, before_state, after_state
  ) values (
    'user_restore', p_user_id, v_actor, to_jsonb(v_before), to_jsonb(v_after)
  );
  return v_after;
end;
$fn$;

create or replace function public.chat_admin_update_member_permissions(
  p_group_id bigint,
  p_user_id uuid,
  p_can_view boolean,
  p_can_send boolean,
  p_can_invite boolean,
  p_can_manage boolean,
  p_actor text
)
returns public.chat_group_members
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_before public.chat_group_members;
  v_after public.chat_group_members;
  v_direct boolean;
  v_is_bot boolean;
  v_can_view boolean;
  v_can_send boolean;
  v_can_invite boolean;
  v_can_manage boolean;
  v_actor text := left(coalesce(nullif(btrim(p_actor), ''), 'chat-admin'), 200);
begin
  select coalesce(is_direct, false) into v_direct
  from public.chat_groups where id = p_group_id;
  if not found then raise exception 'ルームが見つかりません'; end if;
  select coalesce(is_bot, false) into v_is_bot
  from public.chat_users where id = p_user_id;
  if not found then raise exception 'ユーザーが見つかりません'; end if;
  if v_is_bot then raise exception 'Botのルーム権限は変更できません'; end if;

  select * into v_before from public.chat_group_members
  where group_id = p_group_id and user_id = p_user_id for update;
  if not found then raise exception 'このユーザーはルームに参加していません'; end if;

  v_can_view := coalesce(p_can_view, v_before.can_view);
  v_can_send := case when v_can_view then coalesce(p_can_send, v_before.can_send) else false end;
  v_can_invite := case
    when v_can_view and not v_direct then coalesce(p_can_invite, v_before.can_invite)
    else false
  end;
  v_can_manage := case
    when v_can_view and not v_direct then coalesce(p_can_manage, v_before.can_manage)
    else false
  end;

  update public.chat_group_members
  set can_view = v_can_view,
      can_send = v_can_send,
      can_invite = v_can_invite,
      can_manage = v_can_manage
  where group_id = p_group_id and user_id = p_user_id
  returning * into v_after;

  insert into public.chat_admin_audit_log (
    action, target_user_id, group_id, actor, before_state, after_state
  ) values (
    'member_permissions_update', p_user_id, p_group_id, v_actor,
    to_jsonb(v_before), to_jsonb(v_after)
  );
  return v_after;
end;
$fn$;

create or replace function public.chat_admin_remove_member(
  p_group_id bigint,
  p_user_id uuid,
  p_actor text
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_before public.chat_group_members;
  v_after public.chat_group_members;
  v_is_bot boolean;
  v_is_direct boolean;
  v_actor text := left(coalesce(nullif(btrim(p_actor), ''), 'chat-admin'), 200);
begin
  select coalesce(is_bot, false) into v_is_bot
  from public.chat_users where id = p_user_id;
  if not found then raise exception 'ユーザーが見つかりません'; end if;
  if v_is_bot then raise exception 'Botはルームから削除できません'; end if;

  select coalesce(is_direct, false) into v_is_direct
  from public.chat_groups where id = p_group_id;
  if not found then raise exception 'ルームが見つかりません'; end if;
  if v_is_direct then
    raise exception '1対1トークの参加者は削除できません。閲覧・送信権限で制限してください';
  end if;

  select * into v_before from public.chat_group_members
  where group_id = p_group_id and user_id = p_user_id for update;
  if not found then raise exception 'このユーザーはルームに参加していません'; end if;

  update public.chat_group_members
  set can_view = false, can_send = false, can_invite = false, can_manage = false
  where group_id = p_group_id and user_id = p_user_id
  returning * into v_after;

  insert into public.chat_admin_audit_log (
    action, target_user_id, group_id, actor, before_state, after_state
  ) values (
    'member_remove', p_user_id, p_group_id, v_actor,
    to_jsonb(v_before), to_jsonb(v_after)
  );
end;
$fn$;

revoke all on function public.chat_admin_update_user_access(uuid, boolean, boolean, boolean, boolean, text, timestamptz, boolean, boolean, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.chat_admin_remove_user(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.chat_admin_restore_user(uuid, text)
  from public, anon, authenticated;
revoke all on function public.chat_admin_update_member_permissions(bigint, uuid, boolean, boolean, boolean, boolean, text)
  from public, anon, authenticated;
revoke all on function public.chat_admin_remove_member(bigint, uuid, text)
  from public, anon, authenticated;

grant execute on function public.chat_admin_update_user_access(uuid, boolean, boolean, boolean, boolean, text, timestamptz, boolean, boolean, timestamptz, text)
  to service_role;
grant execute on function public.chat_admin_remove_user(uuid, text, text)
  to service_role;
grant execute on function public.chat_admin_restore_user(uuid, text)
  to service_role;
grant execute on function public.chat_admin_update_member_permissions(bigint, uuid, boolean, boolean, boolean, boolean, text)
  to service_role;
grant execute on function public.chat_admin_remove_member(bigint, uuid, text)
  to service_role;

-- trigger関数はData APIから直接実行させない。
revoke all on function public.chat_create_default_user_access() from public, anon, authenticated;
revoke all on function public.chat_protect_member_permissions() from public, anon, authenticated;
revoke all on function public.chat_protect_group_security_columns() from public, anon, authenticated;
