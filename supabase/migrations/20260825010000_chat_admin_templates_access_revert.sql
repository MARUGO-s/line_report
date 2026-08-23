-- M-talk管理の運用機能を追加する。
--   1. 権限テンプレートと、複数ルーム／ユーザーへの一括適用（プレビュー付き）
--   2. ユーザー1人の実効アクセス一覧（拒否理由コード付き）
--   3. 監査ログからの復元（現在値が操作直後と一致するときだけ）
-- 20260824010000_chat_admin_permissions.sql の権限モデルを前提にし、既存migrationは編集しない。
-- 追加する管理RPCはすべて service_role 専用。anon/authenticated からは実行できない。

-- ---------------------------------------------------------------------------
-- 1. ルーム4権限の正規化を1か所へ集約
--    1対1の招待・管理禁止と can_view=false のカスケードを、テンプレート経路からも迂回できなくする。
-- ---------------------------------------------------------------------------

create or replace function public.chat_admin_normalize_member_permissions(
  p_is_direct boolean,
  p_can_view boolean,
  p_can_send boolean,
  p_can_invite boolean,
  p_can_manage boolean
)
returns table (can_view boolean, can_send boolean, can_invite boolean, can_manage boolean)
language sql
immutable
as $fn$
  select
    coalesce(p_can_view, false),
    case when coalesce(p_can_view, false) then coalesce(p_can_send, false) else false end,
    case
      when coalesce(p_can_view, false) and not coalesce(p_is_direct, false)
        then coalesce(p_can_invite, false)
      else false
    end,
    case
      when coalesce(p_can_view, false) and not coalesce(p_is_direct, false)
        then coalesce(p_can_manage, false)
      else false
    end
$fn$;

comment on function public.chat_admin_normalize_member_permissions(boolean, boolean, boolean, boolean, boolean) is
  'ルーム4権限の正規化の単一ソース。can_view=falseなら他3権限もfalse、1対1は招待・管理を常にfalseにする。';

-- 既存の単体更新RPCも同じ正規化関数を通す（署名と監査は変更しない）。
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

  -- null は「据え置き」。解決後の値を共通の正規化関数へ渡す。
  select n.can_view, n.can_send, n.can_invite, n.can_manage
    into v_can_view, v_can_send, v_can_invite, v_can_manage
  from public.chat_admin_normalize_member_permissions(
    v_direct,
    coalesce(p_can_view, v_before.can_view),
    coalesce(p_can_send, v_before.can_send),
    coalesce(p_can_invite, v_before.can_invite),
    coalesce(p_can_manage, v_before.can_manage)
  ) n;

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

-- ---------------------------------------------------------------------------
-- 2. 権限テンプレート
-- ---------------------------------------------------------------------------

create table if not exists public.chat_permission_templates (
  key text primary key,
  label text not null,
  description text,
  can_view boolean not null default true,
  can_send boolean not null default true,
  can_invite boolean not null default false,
  can_manage boolean not null default false,
  is_builtin boolean not null default false,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_permission_templates_key_format check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  constraint chat_permission_templates_label_length check (char_length(label) between 1 and 60),
  constraint chat_permission_templates_description_length check (
    description is null or char_length(description) <= 200
  ),
  constraint chat_permission_templates_view_required check (
    can_view = true
    or (can_send = false and can_invite = false and can_manage = false)
  )
);

comment on table public.chat_permission_templates is
  'M-talkのルーム別4権限のテンプレート。管理画面の一括設定でのみ使用し、公開Data APIからは参照不可。';

insert into public.chat_permission_templates (key, label, description, can_view, can_send, can_invite, can_manage, is_builtin, sort_order)
values
  ('viewer', '閲覧のみ', 'ルームと参加後の履歴を読めるが、送信・招待・管理はできない。', true, false, false, false, true, 10),
  ('member', '一般メンバー', '通常の参加者。閲覧・送信・招待ができ、ルーム設定は変更できない。', true, true, true, false, true, 20),
  ('room_admin', 'ルーム管理者', 'ルーム名・アイコン・メンバー・ゴミ箱まで管理できる。', true, true, true, true, true, 30)
on conflict (key) do update
set label = excluded.label,
    description = excluded.description,
    can_view = excluded.can_view,
    can_send = excluded.can_send,
    can_invite = excluded.can_invite,
    can_manage = excluded.can_manage,
    is_builtin = true,
    sort_order = excluded.sort_order,
    updated_at = now()
where public.chat_permission_templates.is_builtin;

alter table public.chat_permission_templates enable row level security;
revoke all on table public.chat_permission_templates from public, anon, authenticated;
grant select, insert, update, delete on table public.chat_permission_templates to service_role;

-- ---------------------------------------------------------------------------
-- 3. テンプレートの一括適用（p_dry_run=true はプレビュー専用で書き込まない）
-- ---------------------------------------------------------------------------

create or replace function public.chat_admin_apply_room_template(
  p_group_ids bigint[],
  p_user_ids uuid[],
  p_template_key text,
  p_dry_run boolean,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  -- 1クリックで書き換えられる参加行の上限。性能ではなく被害範囲の制限。
  -- 実測(2026-08-25本番): 全参加行57、1ルーム最大3人、1ユーザー最大27ルーム。
  v_max_targets constant integer := 100;
  v_template public.chat_permission_templates;
  v_actor text := left(coalesce(nullif(btrim(p_actor), ''), 'chat-admin'), 200);
  v_dry boolean := coalesce(p_dry_run, false);
  v_groups bigint[] := coalesce(p_group_ids, '{}'::bigint[]);
  v_users uuid[] := coalesce(p_user_ids, '{}'::uuid[]);
  v_target_count integer := 0;
  v_change_count integer := 0;
  v_preview jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_row record;
  v_can_view boolean;
  v_can_send boolean;
  v_can_invite boolean;
  v_can_manage boolean;
  v_changed boolean;
begin
  if cardinality(v_groups) = 0 and cardinality(v_users) = 0 then
    raise exception '適用対象のルームまたはユーザーを指定してください';
  end if;

  select * into v_template
  from public.chat_permission_templates where key = p_template_key;
  if not found then
    raise exception '権限テンプレートが見つかりません: %', coalesce(p_template_key, '(null)');
  end if;

  select count(*) into v_target_count
  from public.chat_group_members gm
  where (cardinality(v_groups) = 0 or gm.group_id = any(v_groups))
    and (cardinality(v_users) = 0 or gm.user_id = any(v_users));

  if v_target_count = 0 then
    raise exception '対象の参加者が見つかりません';
  end if;
  if v_target_count > v_max_targets then
    raise exception '一括適用は%件までです（対象%件）。ルームまたはユーザーを絞ってください', v_max_targets, v_target_count;
  end if;

  for v_row in
    select gm.group_id,
           gm.user_id,
           gm.can_view,
           gm.can_send,
           gm.can_invite,
           gm.can_manage,
           coalesce(g.is_direct, false) as is_direct,
           g.group_name,
           g.trashed_at,
           u.username,
           coalesce(u.is_bot, false) as is_bot,
           a.deleted_at as user_deleted_at
    from public.chat_group_members gm
    join public.chat_groups g on g.id = gm.group_id
    join public.chat_users u on u.id = gm.user_id
    left join public.chat_user_access a on a.user_id = gm.user_id
    where (cardinality(v_groups) = 0 or gm.group_id = any(v_groups))
      and (cardinality(v_users) = 0 or gm.user_id = any(v_users))
    order by gm.group_id, gm.user_id
  loop
    -- Botは対象外。論理削除済みユーザーは復元用のスナップショットを壊さないため触らない。
    if v_row.is_bot then
      v_skipped := v_skipped || jsonb_build_object(
        'group_id', v_row.group_id, 'user_id', v_row.user_id,
        'username', v_row.username, 'reason', 'bot'
      );
      continue;
    end if;
    if v_row.user_deleted_at is not null then
      v_skipped := v_skipped || jsonb_build_object(
        'group_id', v_row.group_id, 'user_id', v_row.user_id,
        'username', v_row.username, 'reason', 'user_deleted'
      );
      continue;
    end if;

    select n.can_view, n.can_send, n.can_invite, n.can_manage
      into v_can_view, v_can_send, v_can_invite, v_can_manage
    from public.chat_admin_normalize_member_permissions(
      v_row.is_direct,
      v_template.can_view, v_template.can_send, v_template.can_invite, v_template.can_manage
    ) n;

    v_changed := v_row.can_view is distinct from v_can_view
      or v_row.can_send is distinct from v_can_send
      or v_row.can_invite is distinct from v_can_invite
      or v_row.can_manage is distinct from v_can_manage;

    v_preview := v_preview || jsonb_build_object(
      'group_id', v_row.group_id,
      'group_name', v_row.group_name,
      'is_direct', v_row.is_direct,
      'room_trashed', v_row.trashed_at is not null,
      'user_id', v_row.user_id,
      'username', v_row.username,
      'changed', v_changed,
      'before', jsonb_build_object(
        'can_view', v_row.can_view, 'can_send', v_row.can_send,
        'can_invite', v_row.can_invite, 'can_manage', v_row.can_manage
      ),
      'after', jsonb_build_object(
        'can_view', v_can_view, 'can_send', v_can_send,
        'can_invite', v_can_invite, 'can_manage', v_can_manage
      )
    );

    if v_changed then
      v_change_count := v_change_count + 1;
      if not v_dry then
        -- 単体更新RPCへ委譲し、行ロック・正規化・監査ログを1本化する。
        perform public.chat_admin_update_member_permissions(
          v_row.group_id, v_row.user_id,
          v_can_view, v_can_send, v_can_invite, v_can_manage,
          left(v_actor || ' [template:' || v_template.key || ']', 200)
        );
      end if;
    end if;
  end loop;

  if not v_dry and v_change_count > 0 then
    insert into public.chat_admin_audit_log (
      action, actor, before_state, after_state
    ) values (
      'template_apply', v_actor,
      jsonb_build_object(
        'template_key', v_template.key,
        'group_ids', to_jsonb(v_groups),
        'user_ids', to_jsonb(v_users)
      ),
      jsonb_build_object(
        'template_key', v_template.key,
        'label', v_template.label,
        'target_count', v_target_count,
        'change_count', v_change_count,
        'permissions', jsonb_build_object(
          'can_view', v_template.can_view, 'can_send', v_template.can_send,
          'can_invite', v_template.can_invite, 'can_manage', v_template.can_manage
        )
      )
    );
  end if;

  return jsonb_build_object(
    'dry_run', v_dry,
    'template', to_jsonb(v_template),
    'max_targets', v_max_targets,
    'target_count', v_target_count,
    'change_count', v_change_count,
    'skipped', v_skipped,
    'preview', v_preview,
    'generated_at', now()
  );
end;
$fn$;

comment on function public.chat_admin_apply_room_template(bigint[], uuid[], text, boolean, text) is
  'テンプレートを複数ルーム／ユーザーの参加者へ一括適用する。p_dry_run=trueは書き込まずに同じ差分を返す。1回の呼び出し＝1トランザクション。';

-- ---------------------------------------------------------------------------
-- 4. ユーザー1人の実効アクセス一覧
-- ---------------------------------------------------------------------------

create or replace function public.chat_admin_user_effective_access(
  p_user_id uuid,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user public.chat_users;
  v_access public.chat_user_access;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total integer := 0;
  v_rooms jsonb := '[]'::jsonb;
  v_global_ok boolean;
  v_global_reason text;
  v_deleted boolean;
  v_disabled boolean;
  v_restricted boolean;
begin
  select * into v_user from public.chat_users where id = p_user_id;
  if not found then raise exception 'ユーザーが見つかりません'; end if;
  -- 読み取り専用。access行が無い場合も既定値(すべて有効)として扱う。
  select * into v_access from public.chat_user_access where user_id = p_user_id;

  v_deleted := v_access.deleted_at is not null;
  v_disabled := v_access.user_id is not null and v_access.access_enabled = false;
  v_restricted := v_access.restricted_until is not null and v_access.restricted_until > now();
  v_global_ok := not (v_deleted or v_disabled or v_restricted);
  v_global_reason := case
    when v_deleted then 'user_deleted'
    when v_disabled then 'user_disabled'
    when v_restricted then 'user_restricted'
    else null
  end;

  select count(*) into v_total
  from public.chat_group_members gm where gm.user_id = p_user_id;

  select coalesce(jsonb_agg(t.entry order by t.ord), '[]'::jsonb) into v_rooms
  from (
    select row_number() over (order by gm.joined_at desc nulls last, gm.group_id desc) as ord,
      jsonb_build_object(
        'group_id', gm.group_id,
        'group_name', g.group_name,
        'is_direct', coalesce(g.is_direct, false),
        'is_store_room', coalesce(g.is_store_room, false),
        'store_key', g.store_key,
        'trashed_at', g.trashed_at,
        'joined_at', gm.joined_at,
        'member_count', (
          select count(*) from public.chat_group_members m2 where m2.group_id = gm.group_id
        ),
        'granted', jsonb_build_object(
          'can_view', gm.can_view, 'can_send', gm.can_send,
          'can_invite', gm.can_invite, 'can_manage', gm.can_manage
        ),
        'effective', jsonb_build_object(
          'can_view', v_global_ok and gm.can_view,
          'can_send', v_global_ok and gm.can_view and gm.can_send,
          'can_invite', v_global_ok and gm.can_view and gm.can_invite and not coalesce(g.is_direct, false),
          'can_manage', v_global_ok and gm.can_view and gm.can_manage and not coalesce(g.is_direct, false)
        ),
        'denial_reasons', (
          select coalesce(jsonb_agg(r.code), '[]'::jsonb)
          from unnest(array[
            v_global_reason,
            case when not gm.can_view then 'room_view_denied' end,
            case when gm.can_view and not gm.can_send then 'room_send_denied' end,
            case when coalesce(g.is_direct, false) then 'room_direct_locked' end,
            case when not coalesce(g.is_direct, false) and gm.can_view and not gm.can_invite
              then 'room_invite_denied' end,
            case when not coalesce(g.is_direct, false) and gm.can_view and not gm.can_manage
              then 'room_manage_denied' end,
            case when g.trashed_at is not null then 'room_trashed' end
          ]) as r(code)
          where r.code is not null
        )
      ) as entry
    from public.chat_group_members gm
    join public.chat_groups g on g.id = gm.group_id
    where gm.user_id = p_user_id
    order by gm.joined_at desc nulls last, gm.group_id desc
    offset v_offset
    limit v_limit
  ) t;

  return jsonb_build_object(
    'user', jsonb_build_object(
      'id', v_user.id,
      'username', v_user.username,
      'icon_url', v_user.icon_url,
      'is_bot', coalesce(v_user.is_bot, false),
      'store_key', v_user.store_key,
      'created_at', v_user.created_at
    ),
    'access', jsonb_build_object(
      'access_enabled', coalesce(v_access.access_enabled, true),
      'can_start_direct', coalesce(v_access.can_start_direct, true),
      'can_create_group', coalesce(v_access.can_create_group, true),
      'can_browse_users', coalesce(v_access.can_browse_users, true),
      'restriction_reason', v_access.restriction_reason,
      'restricted_until', v_access.restricted_until,
      'deleted_at', v_access.deleted_at,
      'updated_at', v_access.updated_at,
      'updated_by', v_access.updated_by
    ),
    'effective', jsonb_build_object(
      'can_use_mtalk', v_global_ok,
      'blocked_reason', v_global_reason
    ),
    'total_rooms', v_total,
    'limit', v_limit,
    'offset', v_offset,
    'rooms', v_rooms,
    'generated_at', now()
  );
end;
$fn$;

comment on function public.chat_admin_user_effective_access(uuid, integer, integer) is
  'ユーザー1人の全体権限・参加ルーム・4権限・実効的な拒否理由コードを返す。メッセージ本文は含めない。';

-- ---------------------------------------------------------------------------
-- 5. 監査ログからの復元
-- ---------------------------------------------------------------------------

alter table public.chat_admin_audit_log
  add column if not exists source_audit_id bigint references public.chat_admin_audit_log(id);

create index if not exists chat_admin_audit_source_idx
  on public.chat_admin_audit_log (source_audit_id)
  where source_audit_id is not null;

comment on column public.chat_admin_audit_log.source_audit_id is
  '復元操作(action=audit_revert)が元に戻した監査ログのID。同じログの二重復元を防ぐ。';

create or replace function public.chat_admin_revert_audit(
  p_audit_id bigint,
  p_dry_run boolean,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_log public.chat_admin_audit_log;
  v_actor text := left(coalesce(nullif(btrim(p_actor), ''), 'chat-admin'), 200);
  v_dry boolean := coalesce(p_dry_run, false);
  v_access public.chat_user_access;
  v_member public.chat_group_members;
  v_current jsonb;
  v_restore jsonb;
  v_target jsonb;
  v_username text;
  v_group_name text;
begin
  select * into v_log from public.chat_admin_audit_log where id = p_audit_id;
  if not found then raise exception '監査ログが見つかりません'; end if;

  -- 復元可能な操作だけをホワイトリストで許可する。
  -- 物理削除・ルーム完全削除・メッセージ消去のような復元不能操作は対象外。
  if v_log.action not in (
    'user_access_update', 'user_remove', 'member_permissions_update', 'member_remove'
  ) then
    raise exception 'この操作は元に戻せません: %', v_log.action;
  end if;
  if v_log.before_state is null or v_log.after_state is null then
    raise exception '変更前後の状態が記録されていないため復元できません';
  end if;
  if exists (
    select 1 from public.chat_admin_audit_log where source_audit_id = v_log.id
  ) then
    raise exception 'この監査ログは既に復元済みです';
  end if;

  select username into v_username from public.chat_users where id = v_log.target_user_id;

  if v_log.action in ('user_access_update', 'user_remove') then
    if (v_log.before_state->>'deleted_at') is not null then
      raise exception '削除済み状態へ戻す復元は行いません';
    end if;

    select * into v_access from public.chat_user_access
    where user_id = v_log.target_user_id for update;
    if not found then raise exception '対象ユーザーの利用設定が見つかりません'; end if;

    -- 現在値が「その操作の直後」と一致するときだけ復元する。
    if v_access.updated_at is distinct from nullif(v_log.after_state->>'updated_at', '')::timestamptz then
      raise exception using
        errcode = '40001',
        message = '別の管理者が先に更新しました。再読み込みしてやり直してください';
    end if;

    v_current := to_jsonb(v_access);
    v_restore := jsonb_build_object(
      'access_enabled', (v_log.before_state->>'access_enabled')::boolean,
      'can_start_direct', (v_log.before_state->>'can_start_direct')::boolean,
      'can_create_group', (v_log.before_state->>'can_create_group')::boolean,
      'can_browse_users', (v_log.before_state->>'can_browse_users')::boolean,
      'restriction_reason', v_log.before_state->>'restriction_reason',
      'restricted_until', v_log.before_state->>'restricted_until',
      'deleted_at', null
    );
    v_target := jsonb_build_object(
      'kind', 'user', 'user_id', v_log.target_user_id, 'username', v_username
    );
    if v_dry then
      return jsonb_build_object(
        'dry_run', true, 'audit_id', v_log.id, 'action', v_log.action,
        'target', v_target, 'current', v_current, 'restore_to', v_restore, 'reverted', false
      );
    end if;

    -- 論理削除の解除は既存の復元RPCへ委譲する（重複実装しない）。
    if v_access.deleted_at is not null then
      perform public.chat_admin_restore_user(v_log.target_user_id, v_actor);
      select * into v_access from public.chat_user_access where user_id = v_log.target_user_id;
    end if;

    -- 残りの項目は既存の更新RPCへ委譲し、楽観ロックと監査記録を共通化する。
    perform public.chat_admin_update_user_access(
      v_log.target_user_id,
      (v_log.before_state->>'access_enabled')::boolean,
      (v_log.before_state->>'can_start_direct')::boolean,
      (v_log.before_state->>'can_create_group')::boolean,
      (v_log.before_state->>'can_browse_users')::boolean,
      v_log.before_state->>'restriction_reason',
      nullif(v_log.before_state->>'restricted_until', '')::timestamptz,
      true,
      true,
      v_access.updated_at,
      v_actor
    );
  else
    select * into v_member from public.chat_group_members
    where group_id = v_log.group_id and user_id = v_log.target_user_id for update;
    if not found then raise exception '対象の参加者が見つかりません'; end if;
    select group_name into v_group_name from public.chat_groups where id = v_log.group_id;

    if v_member.can_view is distinct from (v_log.after_state->>'can_view')::boolean
      or v_member.can_send is distinct from (v_log.after_state->>'can_send')::boolean
      or v_member.can_invite is distinct from (v_log.after_state->>'can_invite')::boolean
      or v_member.can_manage is distinct from (v_log.after_state->>'can_manage')::boolean
    then
      raise exception using
        errcode = '40001',
        message = '別の管理者が先に更新しました。再読み込みしてやり直してください';
    end if;

    v_current := jsonb_build_object(
      'can_view', v_member.can_view, 'can_send', v_member.can_send,
      'can_invite', v_member.can_invite, 'can_manage', v_member.can_manage
    );
    v_restore := jsonb_build_object(
      'can_view', (v_log.before_state->>'can_view')::boolean,
      'can_send', (v_log.before_state->>'can_send')::boolean,
      'can_invite', (v_log.before_state->>'can_invite')::boolean,
      'can_manage', (v_log.before_state->>'can_manage')::boolean
    );
    v_target := jsonb_build_object(
      'kind', 'member', 'user_id', v_log.target_user_id, 'username', v_username,
      'group_id', v_log.group_id, 'group_name', v_group_name
    );
    if v_dry then
      return jsonb_build_object(
        'dry_run', true, 'audit_id', v_log.id, 'action', v_log.action,
        'target', v_target, 'current', v_current, 'restore_to', v_restore, 'reverted', false
      );
    end if;

    perform public.chat_admin_update_member_permissions(
      v_log.group_id,
      v_log.target_user_id,
      (v_log.before_state->>'can_view')::boolean,
      (v_log.before_state->>'can_send')::boolean,
      (v_log.before_state->>'can_invite')::boolean,
      (v_log.before_state->>'can_manage')::boolean,
      v_actor
    );
  end if;

  insert into public.chat_admin_audit_log (
    action, target_user_id, group_id, actor, before_state, after_state, source_audit_id
  ) values (
    'audit_revert', v_log.target_user_id, v_log.group_id, v_actor,
    v_current, v_restore, v_log.id
  );

  return jsonb_build_object(
    'dry_run', false, 'audit_id', v_log.id, 'action', v_log.action,
    'target', v_target, 'current', v_current, 'restore_to', v_restore, 'reverted', true
  );
end;
$fn$;

comment on function public.chat_admin_revert_audit(bigint, boolean, text) is
  '監査ログの before_state へ戻す。現在値が after_state と一致するときだけ実行し、不一致は40001。復元自体も監査へ残す。';

-- ---------------------------------------------------------------------------
-- 6. 実行権限（すべて service_role 専用）
-- ---------------------------------------------------------------------------

revoke all on function public.chat_admin_normalize_member_permissions(boolean, boolean, boolean, boolean, boolean)
  from public, anon, authenticated;
revoke all on function public.chat_admin_apply_room_template(bigint[], uuid[], text, boolean, text)
  from public, anon, authenticated;
revoke all on function public.chat_admin_user_effective_access(uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function public.chat_admin_revert_audit(bigint, boolean, text)
  from public, anon, authenticated;

grant execute on function public.chat_admin_normalize_member_permissions(boolean, boolean, boolean, boolean, boolean)
  to service_role;
grant execute on function public.chat_admin_apply_room_template(bigint[], uuid[], text, boolean, text)
  to service_role;
grant execute on function public.chat_admin_user_effective_access(uuid, integer, integer)
  to service_role;
grant execute on function public.chat_admin_revert_audit(bigint, boolean, text)
  to service_role;
