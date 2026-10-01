-- 「AI分析」Bot の「最新を調べる／今あるデータで答える」の選択を廃止（2026-10-01 18:40 の利用者の決定）。
--
-- gourmet の AI分析は、データの質問にも常にすぐ、取り込み済みのデータ（毎日の取得でためた確定値）で答える。
-- 答えには各サイトの最終取得日時（日本時間）と対象期間が付き、古い（36時間超）・未取得のサイトはそう書く。
-- そのため mtalk-external-post は選択のカード（ai_chat_choice）も「最新を調べる」の見張り（ai_chat_live）も作らず、
-- POST /chat-reply も受け付けない。
--
-- 毎分の見張り high-frequency-dispatcher-cron-job はそのまま（関数の定義を変えない）。呼び出し先の
-- chat_ai_analysis_live_timeouts() だけを「何も投稿しない」関数に置き換える。残っている見張り（pending、または
-- answered なのに1通目が記録されていないもの）は、案内を送らずに failed で閉じる（過去の行は履歴として残す）。

create or replace function public.chat_ai_analysis_live_timeouts()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- 案内は送らない（選択の機能は廃止）。閉じ忘れの見張りだけを静かに閉じる。
  update public.chat_alert_dispatches
     set status = 'failed', finished_at = coalesce(finished_at, now())
   where kind = 'ai_chat_live'
     and message_id is null
     and status in ('pending', 'answered');
  return 0;
end;
$fn$;

revoke all on function public.chat_ai_analysis_live_timeouts() from public, anon, authenticated;
grant execute on function public.chat_ai_analysis_live_timeouts() to postgres, service_role;

-- 適用時点で開いている見張りも閉じる（関数と同じ条件）
update public.chat_alert_dispatches
   set status = 'failed', finished_at = coalesce(finished_at, now())
 where kind = 'ai_chat_live'
   and message_id is null
   and status in ('pending', 'answered');

comment on function public.chat_ai_analysis_live_timeouts() is
  '廃止（2026-10-01）: 「最新を調べる」の見張り。何も投稿せず、閉じ忘れの ai_chat_live の行を failed にするだけ。high-frequency-dispatcher から毎分呼ばれる。';
