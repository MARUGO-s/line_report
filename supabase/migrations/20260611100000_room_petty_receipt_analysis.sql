-- 小口（経費）レシート取込フローのルーム権限（レシート関連タブ「小口レシートの解析をする」）。
--   ON(既定): 「経費」トリガー／レジ出金伝票の検知／店名不一致カードの「経費として記録」ボタンが作動し、
--             「AI返信完全無し」(bot_reply_hard_mute_enabled) が ON でも経費フローの解析・返信は優先して行う。
--   OFF: 経費フローを停止（※レジ出金伝票の検知だけは維持し、売上への誤登録は引き続き防ぐ。カードは出さない）。
alter table public.room_summary_settings
  add column if not exists petty_receipt_analysis_enabled boolean not null default true;

comment on column public.room_summary_settings.petty_receipt_analysis_enabled
  is '小口（経費）レシート解析の許可。ON=経費フロー作動（AI返信完全無しでも優先して解析・返信）／OFF=停止。既定ON。';
