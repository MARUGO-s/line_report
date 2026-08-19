-- ユーザーごとのトークピン留め。LINE と同じく自分の一覧の上に固定する。

alter table public.chat_group_members
  add column if not exists pinned_at timestamptz;

comment on column public.chat_group_members.pinned_at is
  'このユーザーがトークをピン留めした時刻。null なら未ピン。一覧ではピン留めが上に来る。';

create index if not exists idx_chat_group_members_pinned
  on public.chat_group_members (user_id, pinned_at desc)
  where pinned_at is not null;

create or replace function public.chat_set_pin(p_group_id bigint, p_pinned boolean)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'ログインしてください';
  end if;
  if not public.chat_is_member(p_group_id) then
    raise exception 'このトークをピン留めする権限がありません';
  end if;

  if coalesce(p_pinned, false) then
    select count(*)::integer into v_count
    from public.chat_group_members
    where user_id = auth.uid()
      and pinned_at is not null
      and group_id <> p_group_id;
    if v_count >= 5 then
      raise exception 'ピン留めは5件までです';
    end if;
    update public.chat_group_members
    set pinned_at = coalesce(pinned_at, now())
    where group_id = p_group_id
      and user_id = auth.uid();
  else
    update public.chat_group_members
    set pinned_at = null
    where group_id = p_group_id
      and user_id = auth.uid();
  end if;
end;
$fn$;

revoke all on function public.chat_set_pin(bigint, boolean) from public, anon;
grant execute on function public.chat_set_pin(bigint, boolean) to authenticated;

comment on function public.chat_set_pin(bigint, boolean) is
  'ログイン中ユーザーの参加トークをピン留め／解除する。上限は5件。';
