-- 戦略系の質問では、合成の前に Perplexity / Grok が毎回 Web・X を検索する。
-- 取得結果はキャッシュされていないため、同じ店舗・同じ質問でもプロンプトが
-- 毎回変わり、出力が揃わない。外部呼び出し自体も遅く、Grok は既定45秒待つ。
--
-- 同じ日の同じ質問なら同じ外部知見を使い回す。出力のばらつきが減り、
-- 2回目以降は外部待ちがゼロになる。売上数値の解析ロジックには関与しない。
create table if not exists public.journal_ai_brief_cache (
  cache_key text primary key
    constraint journal_ai_brief_cache_key_check check (btrim(cache_key) <> ''),
  store_partition_key text not null
    constraint journal_ai_brief_cache_store_check check (btrim(store_partition_key) <> ''),
  -- gatherExternalBriefs の戻り値をそのまま入れる。provider ごとの ok/error も
  -- 保持し、失敗も含めて同じ状態を再現できるようにする。
  briefs jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

comment on table public.journal_ai_brief_cache is
  '外部知見ブリーフ(Perplexity/Grok)の短期キャッシュ。同一条件の再実行で出力を揃え、外部待ちを省く。';
comment on column public.journal_ai_brief_cache.cache_key is
  '店舗・正規化した質問・意図・日付から作る決定的なキー。';
comment on column public.journal_ai_brief_cache.expires_at is
  'これを過ぎた行は読まない。日付をまたぐと外部知見の鮮度が落ちるため既定は当日中。';

-- 期限切れの掃除に使う。
create index if not exists idx_journal_ai_brief_cache_expires
  on public.journal_ai_brief_cache (expires_at);

-- 外部から取得した非信頼データを含む。一般利用者には触らせない。
alter table public.journal_ai_brief_cache enable row level security;
revoke all on table public.journal_ai_brief_cache from public, anon, authenticated;
grant select, insert, update, delete on table public.journal_ai_brief_cache to service_role;
