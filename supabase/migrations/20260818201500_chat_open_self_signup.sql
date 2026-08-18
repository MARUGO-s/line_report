-- チャットの新規登録を開放する。
-- 許可リスト chat_allowed_emails は残すが、プロフィール作成時の必須チェックは外す。
-- Confirm email の設定は変更しない。

drop trigger if exists chat_users_allowed_email on public.chat_users;

create or replace function public.chat_enforce_allowed_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- 許可リストは使わない。本人のプロフィール作成だけ残す。
  if auth.uid() is not null and new.id <> auth.uid() then
    raise exception 'プロフィールは本人のみ作成できます';
  end if;
  return new;
end;
$fn$;

drop trigger if exists chat_users_self_profile on public.chat_users;
create trigger chat_users_self_profile
before insert on public.chat_users
for each row execute function public.chat_enforce_allowed_email();

comment on table public.chat_allowed_emails is
  '旧チャット許可リスト。セルフ登録の制限には使わない。';
