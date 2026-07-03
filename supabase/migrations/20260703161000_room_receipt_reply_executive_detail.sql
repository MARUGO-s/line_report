-- 日計精算レシートの返信内容をルーム単位で出し分ける。
--   true(既定): 当日売上に加えて、月累計・予算・昨対も返信する（幹部ルーム向け）。
--   false: 当日のレシート結果だけ返信する（通常ルーム向け）。
-- 既定は true にして、既存ルームの返信内容を変えずに後から絞れるようにする。
alter table public.room_summary_settings
  add column if not exists receipt_reply_executive_detail_enabled boolean not null default true;

comment on column public.room_summary_settings.receipt_reply_executive_detail_enabled is
  '日計精算レシート返信に月累計・予算・昨対を含めるか。true=幹部向け詳細あり、false=当日売上のみ。既定true。';
