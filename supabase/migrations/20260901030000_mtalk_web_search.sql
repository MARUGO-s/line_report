-- M-talk 1対1の雑談・使い方AIに、Web検索（Perplexity Sonar）で答えさせるかをルーム単位で切り替える。
--   false(既定): 従来どおり統合マニュアルと店舗データだけで答える（Web検索の課金は発生しない）。
--   true: マニュアルに無く、かつ外部の最新情報が要る質問のときだけ Perplexity を呼ぶ。
-- Perplexity は Journal Report AI（journal_ai_orchestrate.ts）と同じ PERPLEXITY_API_KEY を使う。
-- 1回あたり基本料金 $5〜$14/1000リクエスト＋トークン課金が発生するため、既定は false。
alter table public.room_summary_settings
  add column if not exists mtalk_web_search_enabled boolean not null default false;

comment on column public.room_summary_settings.mtalk_web_search_enabled is
  'M-talk雑談AIがWeb検索（Perplexity Sonar）で回答してよいか。true=検索あり（従量課金）、false=検索なし。既定false。';

-- 使用する Perplexity のモデル。NULL = 既定の 'sonar'。
--   sonar     : 基本料金 $5〜$12/1000req、入出力 $1/1Mトークン。通常の事実確認はこれで足りる。
--   sonar-pro : 基本料金 $6〜$14/1000req、入力 $3 / 出力 $15 per 1Mトークン。より深い調査向け。
-- 値は admin-api 側でも許可リスト検証するため、DB制約と二重で守る。
alter table public.room_summary_settings
  add column if not exists mtalk_web_search_model text;

alter table public.room_summary_settings
  drop constraint if exists room_summary_settings_mtalk_web_search_model_check;

alter table public.room_summary_settings
  add constraint room_summary_settings_mtalk_web_search_model_check
  check (mtalk_web_search_model is null or mtalk_web_search_model in ('sonar', 'sonar-pro'));

comment on column public.room_summary_settings.mtalk_web_search_model is
  'M-talk雑談AIのWeb検索に使う Perplexity モデル。NULL=既定 sonar。sonar / sonar-pro のみ許可。';
