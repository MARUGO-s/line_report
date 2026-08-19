-- トーク一覧のスワイプ用。ピン留めに加えて、非通知・非表示をユーザーごとに持つ。

alter table public.chat_group_members
  add column if not exists muted_at timestamptz,
  add column if not exists hidden_at timestamptz;

comment on column public.chat_group_members.muted_at is
  'このトークの通知を止めた時刻。null なら通知する。';
comment on column public.chat_group_members.hidden_at is
  'このトークを一覧から非表示にした時刻。null なら表示する。';

create index if not exists idx_chat_group_members_muted
  on public.chat_group_members (group_id)
  where muted_at is not null;

create or replace function public.chat_set_mute(p_group_id bigint, p_muted boolean)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null then
    raise exception 'ログインしてください';
  end if;
  if not public.chat_is_member(p_group_id) then
    raise exception 'このトークを変更する権限がありません';
  end if;
  update public.chat_group_members
  set muted_at = case when coalesce(p_muted, false) then coalesce(muted_at, now()) else null end
  where group_id = p_group_id
    and user_id = auth.uid();
end;
$fn$;

create or replace function public.chat_set_hidden(p_group_id bigint, p_hidden boolean)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null then
    raise exception 'ログインしてください';
  end if;
  if not public.chat_is_member(p_group_id) then
    raise exception 'このトークを変更する権限がありません';
  end if;
  update public.chat_group_members
  set hidden_at = case when coalesce(p_hidden, false) then coalesce(hidden_at, now()) else null end
  where group_id = p_group_id
    and user_id = auth.uid();
end;
$fn$;

revoke all on function public.chat_set_mute(bigint, boolean) from public, anon;
revoke all on function public.chat_set_hidden(bigint, boolean) from public, anon;
grant execute on function public.chat_set_mute(bigint, boolean) to authenticated;
grant execute on function public.chat_set_hidden(bigint, boolean) to authenticated;

comment on function public.chat_set_mute(bigint, boolean) is
  'ログイン中ユーザーのトーク通知を止める／再開する。';
comment on function public.chat_set_hidden(bigint, boolean) is
  'ログイン中ユーザーのトークを一覧から隠す／戻す。';
