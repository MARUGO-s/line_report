-- AI使用料（概算）ページ用の集計関数。
-- 各店舗の Webhook 受信テーブル（line_webhook_raw__<key>）から、画像メッセージ
-- （payload->message->>type = 'image'）の件数を期間で数える。画像1枚＝AI解析1回の概算。
-- あわせて売上として登録されたレシート件数（line_receipt__<key>）も返す（内訳の参考用）。
-- 店舗の振り分け（Groq / Gemini）は呼び出し側（admin-api）で行う。ここでは店舗別の素の件数のみ。

create or replace function public.ai_usage_image_counts(
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (
  store_partition_key text,
  display_name text,
  image_count bigint,
  receipt_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  img_cnt bigint;
  rcpt_cnt bigint;
  q text;
begin
  for rec in
    select sw.store_partition_key, sw.display_name, sw.webhook_raw_table, sw.receipt_table
    from public.store_webhook_tables sw
    order by sw.store_partition_key
  loop
    -- 画像メッセージ件数（テーブル未作成なら 0）
    img_cnt := 0;
    if to_regclass('public.' || rec.webhook_raw_table) is not null then
      q := format(
        'select count(*)::bigint from public.%I where (payload->''message''->>''type'') = ''image''',
        rec.webhook_raw_table
      );
      if p_from is not null then
        q := q || format(' and received_at >= %L', p_from);
      end if;
      if p_to is not null then
        q := q || format(' and received_at < %L', p_to);
      end if;
      execute q into img_cnt;
    end if;

    -- 登録済みレシート件数（テーブル未作成なら 0）
    rcpt_cnt := 0;
    if to_regclass('public.' || rec.receipt_table) is not null then
      q := format('select count(*)::bigint from public.%I where true', rec.receipt_table);
      if p_from is not null then
        q := q || format(' and created_at >= %L', p_from);
      end if;
      if p_to is not null then
        q := q || format(' and created_at < %L', p_to);
      end if;
      execute q into rcpt_cnt;
    end if;

    store_partition_key := rec.store_partition_key;
    display_name := rec.display_name;
    image_count := coalesce(img_cnt, 0);
    receipt_count := coalesce(rcpt_cnt, 0);
    return next;
  end loop;
  return;
end;
$$;

comment on function public.ai_usage_image_counts(timestamptz, timestamptz) is
  'AI使用料概算用: 店舗別の画像メッセージ件数（=AI解析回数の概算）と登録レシート件数を期間で集計して返す。';

grant execute on function public.ai_usage_image_counts(timestamptz, timestamptz) to service_role;
