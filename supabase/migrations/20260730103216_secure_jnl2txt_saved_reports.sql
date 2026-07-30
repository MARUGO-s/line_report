-- jnl2txt.html（POS電子ジャーナル → 売上分析Webアプリ）の保存済みレポート/AI分析履歴を
-- pos_journal_files / pos_journal_ai_analyses と同じアクセス方式へ揃える。
--
-- これまでは RLS ポリシーが USING (true) の全公開設定になっており、ページに埋め込まれた
-- anon キーだけで誰でも全店舗のレポートを閲覧・改ざん・削除できてしまっていた
-- (Supabase Advisor: rls_policy_always_true を saved_reports/ai_analysis_history に対して検出済み)。
-- 公開Pagesはこれらのテーブルを直接参照せず、service_role を使う admin-api 経由のみで
-- 操作する（pos_journal_files のコメント方針に合わせる）。

-- store_partition_key を追加し、他の店舗別テーブルと同じスコープ方式に揃える。
-- 既存行は本アプリの唯一の稼働店舗 'bistrocavacava'（pos-journal.html と同一）で埋める。
alter table public.saved_reports
  add column if not exists store_partition_key text not null default 'bistrocavacava';

alter table public.ai_analysis_history
  add column if not exists store_partition_key text not null default 'bistrocavacava';

-- ダッシュボード再現用の売上データスナップショット列。
-- 従来のクライアントコードは sales_data を送っていたが、対応する列が存在せず保存されていなかった。
alter table public.ai_analysis_history
  add column if not exists sales_data jsonb;

create index if not exists saved_reports_store_created_idx
  on public.saved_reports (store_partition_key, created_at desc);
create index if not exists ai_analysis_history_store_created_idx
  on public.ai_analysis_history (store_partition_key, created_at desc);

-- 全公開ポリシーを削除し、anon/authenticated からのアクセスを完全に剥奪する。
drop policy if exists "Allow public read access" on public.saved_reports;
drop policy if exists "Allow public insert access" on public.saved_reports;
drop policy if exists "Allow public update access" on public.saved_reports;
drop policy if exists "Allow public delete access" on public.saved_reports;

drop policy if exists "Allow public select for ai_analysis_history" on public.ai_analysis_history;
drop policy if exists "Allow public insert for ai_analysis_history" on public.ai_analysis_history;
drop policy if exists "Allow public update for ai_analysis_history" on public.ai_analysis_history;
drop policy if exists "Allow public delete for ai_analysis_history" on public.ai_analysis_history;

alter table public.saved_reports enable row level security;
alter table public.ai_analysis_history enable row level security;

revoke all on table public.saved_reports from anon, authenticated;
revoke all on table public.ai_analysis_history from anon, authenticated;

grant select, insert, update, delete on table public.saved_reports to service_role;
grant select, insert, update, delete on table public.ai_analysis_history to service_role;
