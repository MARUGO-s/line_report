-- 予算登録フローの権限ゲート（部屋ごと）。既定OFF＝「許可」した部屋だけ
-- LINEからの「予算登録」会話フローを受け付ける。他の権限・処理には干渉しない。
alter table public.room_summary_settings
  add column if not exists budget_entry_enabled boolean not null default false;

comment on column public.room_summary_settings.budget_entry_enabled
  is 'ONの部屋だけLINEからの「予算登録」会話フロー（月次予算入力）を受け付ける（既定OFF）。';
