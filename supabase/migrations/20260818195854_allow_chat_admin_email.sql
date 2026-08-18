-- チャット許可リストに管理者メールを登録する。
-- セルフ登録の利用可否は chat_allowed_emails が決める。
-- 確認メール（Confirm email）の設定は変更しない。

insert into public.chat_allowed_emails (email, note)
values ('pingus0428@gmail.com', '管理者')
on conflict (email) do update set note = excluded.note;
