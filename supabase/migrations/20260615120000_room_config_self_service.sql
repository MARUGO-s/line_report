-- ルーム・セルフサービス権限設定（LINEワンパス＋ルーム個別パスワード）用の列を追加。
--
-- 背景: 店舗スタッフが自分のルームの Bot 機能 ON/OFF を、フル管理者を介さず・そのルーム1つだけ
--   設定できるようにする。LINE から届く使い捨てリンク(lrlt_)＋ルーム個別パスワードで二段に守る。
--
-- 列:
--   room_config_password_hash    : アクセスパスワードの SHA-256 ハッシュ（null=未設定＝セルフ設定無効）。
--   room_config_access_enabled   : 管理者が明示的にセルフ設定を許可したルームのみ true。
-- 既存 RLS（service_role 限定）は変更不要。アクセスは admin-api(service_role)＋room スコープ強制で守る。

alter table public.room_summary_settings
  add column if not exists room_config_password_hash text,
  add column if not exists room_config_access_enabled boolean not null default false;

comment on column public.room_summary_settings.room_config_password_hash is
  'ルーム・セルフ設定ページのアクセスパスワードの SHA-256 ハッシュ。null=未設定。admin-api がハッシュ化して保存し、room-config-login で定数時間照合する。';
comment on column public.room_summary_settings.room_config_access_enabled is
  '管理者がこのルームのセルフ設定（LINEワンパス＋パスワード）を許可しているか。既定 false。';
