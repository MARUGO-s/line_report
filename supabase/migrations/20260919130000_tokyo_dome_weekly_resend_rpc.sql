-- ドームシティ週次イベント配信を「任意の週・任意のルーム」へ手動で再送するRPC。
--
-- 背景: 通常配信は「翌週の日曜から14日間」を自動計算するため、日付が変わると対象週も動く。
-- 週を指定して送り直したい場合（時刻表示の追加後に同じ週を配信し直す等）に、
-- SQLエディタから1行で叩けるようにする。Edge側は test_send 経路で重複防止ログを書かないため、
-- 通常の週次配信（土10:00 など）のスケジュールには影響しない。
--
-- 認証: Edge Function 側は「専用ヘッダー」または「内部cron認証」を受け付ける。
-- この関数は後者を使うので、テストキーをURLや手元に置かずに済む。
-- 権限: 既存の invoke_* と同じく public/anon/authenticated からは revoke し、postgres/service_role のみ。

create or replace function public.invoke_tokyo_dome_weekly_resend(
  p_room_id text,
  p_week_start date default null,
  p_store_partition_key text default 'marugos'
)
returns void
language plpgsql
security definer
as $$
declare
  edge_function_url text;
  cron_auth_token text;
  request_id bigint;
  target_url text;
  v_store_key text := coalesce(nullif(btrim(p_store_partition_key), ''), 'marugos');
begin
  if p_room_id is null or btrim(p_room_id) = '' then
    raise exception 'p_room_id is required';
  end if;

  edge_function_url := nullif(current_setting('custom.tokyo_dome_weekly_edge_function_url', true), '');
  if edge_function_url is null then
    edge_function_url := 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/tokyo-dome-weekly-cron';
  end if;

  cron_auth_token := public.resolve_edge_cron_auth_token();
  if cron_auth_token is null then
    raise warning 'invoke_tokyo_dome_weekly_resend skipped: cron auth token is not configured';
    return;
  end if;

  -- URLへ直接載せるため、想定文字種（LINEのID・店舗キー）だけを許可する。
  if btrim(p_room_id) !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'p_room_id contains unsupported characters';
  end if;
  if v_store_key !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'p_store_partition_key contains unsupported characters';
  end if;

  target_url := edge_function_url
    || '?test_send=1'
    || '&room_id=' || btrim(p_room_id)
    || '&store_partition_key=' || v_store_key;
  if p_week_start is not null then
    target_url := target_url || '&week_start=' || to_char(p_week_start, 'YYYY-MM-DD');
  end if;

  select net.http_post(
    url := target_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || cron_auth_token
    ),
    body := '{}'::jsonb
  ) into request_id;

  raise log 'invoke_tokyo_dome_weekly_resend: room=%, week_start=%, request_id=%', p_room_id, p_week_start, request_id;
end;
$$;

revoke all on function public.invoke_tokyo_dome_weekly_resend(text, date, text)
  from public, anon, authenticated;
grant execute on function public.invoke_tokyo_dome_weekly_resend(text, date, text)
  to postgres, service_role;

comment on function public.invoke_tokyo_dome_weekly_resend(text, date, text) is
  '週次ドーム配信を指定週(開始日から14日間)・指定ルームへ再送する。重複防止ログは更新しないため通常配信に影響しない。';
