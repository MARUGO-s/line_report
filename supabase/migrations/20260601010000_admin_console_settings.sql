-- 管理コンソールの「機能・権限の既定値/テンプレ/優先順位」を端末間で共有するための設定テーブル。
-- これまで全体・店舗の既定値やルーム優先順位はブラウザの localStorage に保存しており、端末ごとに
-- 異なり共有されなかった。key→値（文字列）で一元保存し、/state で配布・PUT で更新する。
-- 注: ログイン用トークンとテーマ（ダーク/ライト）は端末ローカルのまま（DB保存しない）。

create table if not exists public.line_admin_console_settings (
  setting_key text primary key,
  setting_value text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.line_admin_console_settings enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'line_admin_console_settings'
      and policyname = 'Service role can do everything on line_admin_console_settings'
  ) then
    create policy "Service role can do everything on line_admin_console_settings"
      on public.line_admin_console_settings
      for all
      using (auth.jwt() ->> 'role' = 'service_role');
  end if;
end;
$$;

comment on table public.line_admin_console_settings
  is '管理コンソールの機能/権限の既定値・テンプレ・優先順位（端末間共有）。key→値の文字列。トークン/テーマは保存しない。';
