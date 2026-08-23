-- chat_admin_normalize_member_permissions に search_path を固定する。
--
-- 20260825010000 でこの関数を追加した際、他の管理関数には付けている
-- `set search_path = public` を付け忘れ、Supabase Advisors の
-- function_search_path_mutable (WARN) が1件増えた。
-- 実害は小さい（SECURITY DEFINER ではなく、EXECUTE は service_role のみ、
-- 呼び出し元の SECURITY DEFINER 関数が search_path を固定している）が、
-- リポジトリ内の他の関数と規約をそろえ、警告を解消する。
--
-- 判定ロジックは 20260825010000 から一切変更しない。
-- create or replace なので既存の GRANT/REVOKE はそのまま維持される。

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
set search_path = public
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

-- 念のため、実行権限が service_role 専用のままであることを再宣言する。
revoke all on function public.chat_admin_normalize_member_permissions(boolean, boolean, boolean, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.chat_admin_normalize_member_permissions(boolean, boolean, boolean, boolean, boolean)
  to service_role;
