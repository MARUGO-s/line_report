-- セキュリティ後始末: 一回限りの移行用ステージングテーブル migration_secret_staging を削除する。
--
-- 背景: secret-bridge Edge Function（任意の環境変数を平文でこのテーブルへ吸い出す移行ツール）を
--   本番から undeploy・リポジトリから削除した。対になるこのテーブルも「平文の秘密を保持しうる設計」で
--   攻撃面になるため恒久削除する。撤去時点で 0 行（中身なし＝移行完了済み）であることを確認済み。
--
-- 関連: secret-bridge/index.ts 削除、scripts/sync-gmail-secrets-jhpm-to-hocbn.mjs 削除。
--   SECRET_BRIDGE_TOKEN / HOCBN_SERVICE_ROLE_KEY シークレットの失効は別途ダッシュボードで実施。

drop table if exists public.migration_secret_staging;
