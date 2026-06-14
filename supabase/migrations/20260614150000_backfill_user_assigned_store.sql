-- 所属店舗(assigned_store)を「ユーザーが発言した店舗」から一括自動補完する（空欄のみ・既存の手動値は尊重）。
--
-- 背景: line_user_permissions.assigned_store は手動の所属店舗。LINEのuser_idは店舗チャネルごとに一意なので、
--   1ユーザー(=1行)＝1店舗に確定する。発言店舗は registration_source_store（登録時に自動記録）か、
--   無ければ各店舗の line_webhook_raw__<店舗>.user_id（実メッセージ履歴）から特定できる。
--
-- 方針（ユーザー確認済み）: 空欄(未選択)の行だけを補完し、手動設定済みは変更しない。admin（承認専用）は所属店舗にしない。
--   表示名は store_webhook_tables.display_name を使う（ドロップダウンの選択肢 MARUGO_GROUP_STORE_OPTIONS と全23店舗で一致）。
-- 一回限りのデータ補完。今後の新規登録は line_user_approval.ts の upsertPendingLineUser が自動設定する。

with raw as (
  select user_id::text uid, 'marugo' st from public.line_webhook_raw__marugo where user_id is not null
  union all select user_id::text, 'marugosecond' from public.line_webhook_raw__marugosecond where user_id is not null
  union all select user_id::text, 'marugogrande' from public.line_webhook_raw__marugogrande where user_id is not null
  union all select user_id::text, 'sannanaichi' from public.line_webhook_raw__sannanaichi where user_id is not null
  union all select user_id::text, 'shenlong' from public.line_webhook_raw__shenlong where user_id is not null
  union all select user_id::text, 'claudia2' from public.line_webhook_raw__claudia2 where user_id is not null
  union all select user_id::text, 'sauvage' from public.line_webhook_raw__sauvage where user_id is not null
  union all select user_id::text, 'barpelota' from public.line_webhook_raw__barpelota where user_id is not null
  union all select user_id::text, 'briccola' from public.line_webhook_raw__briccola where user_id is not null
  union all select user_id::text, 'violette' from public.line_webhook_raw__violette where user_id is not null
  union all select user_id::text, 'marugootto' from public.line_webhook_raw__marugootto where user_id is not null
  union all select user_id::text, 'donaiya' from public.line_webhook_raw__donaiya where user_id is not null
  union all select user_id::text, 'marugoyotsuya' from public.line_webhook_raw__marugoyotsuya where user_id is not null
  union all select user_id::text, 'sushikoruri' from public.line_webhook_raw__sushikoruri where user_id is not null
  union all select user_id::text, 'bistrocavacava' from public.line_webhook_raw__bistrocavacava where user_id is not null
  union all select user_id::text, 'marugoS' from public."line_webhook_raw__marugoS" where user_id is not null
  union all select user_id::text, 'marugoshinbashi' from public.line_webhook_raw__marugoshinbashi where user_id is not null
  union all select user_id::text, 'marugomarunouchi' from public.line_webhook_raw__marugomarunouchi where user_id is not null
  union all select user_id::text, 'yakinikumarugo' from public.line_webhook_raw__yakinikumarugo where user_id is not null
  union all select user_id::text, 'erics' from public.line_webhook_raw__erics where user_id is not null
  union all select user_id::text, 'mitan' from public.line_webhook_raw__mitan where user_id is not null
  union all select user_id::text, 'marugoD' from public."line_webhook_raw__marugoD" where user_id is not null
),
msg_store as (
  -- user_id ごとの発言店舗（admin=承認専用は除外）。user_idは店舗一意なので min() で確定の1件。
  select uid, min(st) as st from raw where st <> 'admin' group by uid
),
derived as (
  select p.line_user_id,
         coalesce(
           nullif(trim(p.registration_source_store), ''),
           (select m.st from msg_store m where m.uid = p.line_user_id)
         ) as store_key
  from public.line_user_permissions p
  where nullif(trim(p.assigned_store), '') is null   -- 空欄のみ
)
update public.line_user_permissions p
set assigned_store = t.display_name,
    updated_at = now()
from derived d
join public.store_webhook_tables t on t.store_partition_key = d.store_key
where p.line_user_id = d.line_user_id
  and d.store_key is not null
  and d.store_key <> 'admin'
  and nullif(trim(p.assigned_store), '') is null;
