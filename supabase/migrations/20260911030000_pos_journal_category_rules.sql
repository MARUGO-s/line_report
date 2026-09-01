-- 商品コードから売上カテゴリを決める範囲を、店舗ごとにDBで持つ。
--
-- これまでの二重管理をやめるための表。
--   1. サーバー(pos_journal.ts)は全店共通のハードコード範囲だけを見ていた。
--      その範囲は Bistro CAVACAVA のコード体系に合わせたもので、マルゴエスでは
--      売上の61%が「その他」へ落ちていた。
--   2. 画面には店舗別のコード範囲設定があるが、保存先が localStorage だった。
--      端末をまたいで共有されず、保存レポートを作るサーバーにも届かないため、
--      設定しても分類は直らなかった。
--
-- 形式は画面の入力欄と同じテキスト仕様のまま持つ。
--   例: '0100-0199, 0250'   （範囲はハイフン、区切りはカンマ・空白・改行）
-- 構造化せずテキストで持つのは、画面の入力内容をそのまま往復させ、
-- サーバーとクライアントで解釈がずれないようにするため。
--
-- 行が無い店舗はコード内の既定値へフォールバックする。したがってこの表が
-- 空でも既存店舗の分類は一切変わらない。
create table if not exists public.pos_journal_category_rules (
  store_partition_key text primary key
    constraint pos_journal_category_rules_key_check
      check (btrim(store_partition_key) <> ''),
  food_codes text not null default '',
  drink_codes text not null default '',
  -- 画面の「その他（個室料金等）」に対応する。実際の割当先は室料。
  room_codes text not null default '',
  -- チャージはカテゴリではなく、いずれかのカテゴリの内数として扱う。
  charge_codes text not null default '',
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.pos_journal_category_rules is
  '店舗ごとの商品コード→売上カテゴリ範囲。行が無ければコード内の既定値を使う。';
comment on column public.pos_journal_category_rules.room_codes is
  '画面の「その他（個室料金等）」欄。マッチした商品は室料へ分類する。';
comment on column public.pos_journal_category_rules.charge_codes is
  'チャージ。独立カテゴリではなく、属するカテゴリの内数として集計する。';

-- 業務設定そのものなので一般利用者には触らせない。service_role だけ。
alter table public.pos_journal_category_rules enable row level security;
revoke all on table public.pos_journal_category_rules from public, anon, authenticated;
grant select, insert, update, delete
  on table public.pos_journal_category_rules to service_role;
