-- レポート送信 cron（receipt-midreport-cron）を「毎分」起動する。
-- 目的: ルーム個別の送信時刻（日・時・分）に対応するため、毎分エッジ関数を叩いて
--       「今この瞬間に送るべきルーム」を関数側で判定・送信させる（該当が無ければ即終了）。
-- 仕組みは既存の receipt-sheets-sync-cron と同一（invoke関数 + net.http_post + pg_cron）。
-- 二重送信は関数側で「送信前に重複防止行を確保（line_receipt_mid_reports の一意制約）」する実装に
-- 変更済みのため、既存スケジューラと併存しても安全。

create or replace function public.invoke_receipt_midreport_cron()
returns void
language plpgsql
security definer
as $$
declare
  edge_function_url text;
  cron_auth_token text;
  request_id bigint;
begin
  edge_function_url := nullif(current_setting('custom.receipt_midreport_edge_function_url', true), '');
  if edge_function_url is null then
    edge_function_url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/receipt-midreport-cron';
  end if;

  cron_auth_token := public.resolve_edge_cron_auth_token();
  if cron_auth_token is null then
    raise warning 'invoke_receipt_midreport_cron skipped: cron auth token is not configured';
    return;
  end if;

  select net.http_post(
    url := edge_function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || cron_auth_token
    ),
    body := '{}'::jsonb
  ) into request_id;

  raise log 'invoke_receipt_midreport_cron: Triggered Edge Function at %, request_id=%', edge_function_url, request_id;
end;
$$;

do $$
begin
  begin
    perform cron.unschedule('receipt-midreport-cron-job');
  exception
    when others then
      null;
  end;
end
$$;

select cron.schedule(
  'receipt-midreport-cron-job',
  '* * * * *',
  $$ select public.invoke_receipt_midreport_cron(); $$
);
