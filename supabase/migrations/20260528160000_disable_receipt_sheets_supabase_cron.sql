-- 全店舗シート同期は GAS の時間トリガー（dailyAutoSync）に一本化する。
-- Supabase pg_cron との同時実行は Sheets API / 進捗ステータスの衝突を招くため無効化。

do $$
begin
  begin
    perform cron.unschedule('receipt-sheets-sync-cron-job');
  exception
    when others then
      null;
  end;
end
$$;

comment on function public.invoke_receipt_sheets_sync_cron() is
  '手動・管理用。定期実行はスプレッドシート GAS dailyAutoSync（朝6時 JST）を使用。';
