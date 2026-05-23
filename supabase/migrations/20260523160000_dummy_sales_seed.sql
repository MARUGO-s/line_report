-- 全店舗 line_receipt__* 向けダミー売上（テスト用）
-- 識別: raw_payload._seed_tag = 'line_report_dummy_sales_v1'
-- 一括削除: select * from public.delete_dummy_store_receipts();

create or replace function public.delete_dummy_store_receipts(
  p_seed_tag text default 'line_report_dummy_sales_v1'
)
returns table(
  store_partition_key text,
  receipt_table text,
  deleted_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  cnt bigint;
begin
  for rec in
    select sw.store_partition_key, sw.receipt_table
    from public.store_webhook_tables sw
    order by sw.store_partition_key
  loop
    execute format(
      $sql$
        delete from public.%I
        where coalesce(raw_payload->>'_seed_tag', '') = $1
      $sql$,
      rec.receipt_table
    ) using p_seed_tag;
    get diagnostics cnt = row_count;
    store_partition_key := rec.store_partition_key;
    receipt_table := rec.receipt_table;
    deleted_count := cnt;
    return next;
  end loop;
end;
$$;

comment on function public.delete_dummy_store_receipts(text) is
  'ダミー売上（raw_payload._seed_tag 一致）を全店舗テーブルから一括削除する。';

create or replace function public.seed_dummy_store_receipts(
  p_seed_tag text default 'line_report_dummy_sales_v1',
  p_years_back integer default 3
)
returns table(
  store_partition_key text,
  receipt_table text,
  inserted_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  d date;
  start_date date;
  end_date date;
  cnt bigint;
  total bigint;
  dow int;
  receipts_today int;
  seq int;
  gross bigint;
  net bigint;
  tax bigint;
  party int;
  guest int;
  unit bigint;
  seed_int int;
  msg_id text;
  payload jsonb;
  created_ts timestamptz;
begin
  if p_years_back < 1 or p_years_back > 10 then
    raise exception 'p_years_back must be between 1 and 10 (got %)', p_years_back;
  end if;

  end_date := (timezone('Asia/Tokyo', now()))::date;
  start_date := end_date - make_interval(years => p_years_back);

  -- 再投入時は既存ダミーのみ削除してから挿入
  perform public.delete_dummy_store_receipts(p_seed_tag);

  for rec in
    select sw.store_partition_key, sw.display_name, sw.receipt_table
    from public.store_webhook_tables sw
    order by sw.store_partition_key
  loop
    total := 0;
    d := start_date;
    while d <= end_date loop
      dow := extract(isodow from d)::int; -- 1=Mon .. 7=Sun
      seed_int := abs(hashtext(rec.store_partition_key || d::text));

      -- 日曜は約半分休業、月曜は約15%休業
      if (dow = 7 and (seed_int % 2) = 0) or (dow = 1 and (seed_int % 7) = 0) then
        d := d + 1;
        continue;
      end if;

      receipts_today := case
        when dow in (5, 6) then 2 + (seed_int % 2)   -- 金土: 2〜3件
        when dow = 7 then 1
        else 1 + (seed_int % 2)                     -- 平日: 1〜2件
      end;

      for seq in 1..receipts_today loop
        seed_int := abs(hashtext(rec.store_partition_key || d::text || seq::text));
        gross := 45000 + (seed_int % 280000);
        tax := (gross * 10) / 110;
        net := gross - tax;
        party := 1 + (seed_int % 4);
        guest := party * (2 + (seed_int % 3));
        unit := case when guest > 0 then gross / guest else gross end;

        msg_id := p_seed_tag || '__' || rec.store_partition_key || '__' || d::text || '__' || seq::text;
        payload := jsonb_build_object(
          '_seed_tag', p_seed_tag,
          'dummy', true,
          'store_partition_key', rec.store_partition_key,
          'receipt_date', d::text
        );
        created_ts := (d + time '21:00:00') at time zone 'Asia/Tokyo';

        execute format(
          $sql$
            insert into public.%I (
              line_message_id,
              room_id,
              user_id,
              sender_display_name,
              store_name,
              receipt_date_text,
              receipt_date,
              net_sales_yen,
              tax_amount_yen,
              gross_sales_yen,
              party_count,
              guest_count,
              unit_price_yen,
              summary_text,
              raw_payload,
              created_at
            ) values (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
            )
            on conflict (line_message_id) do nothing
          $sql$,
          rec.receipt_table
        )
        using
          msg_id,
          'dummy_room__' || rec.store_partition_key,
          'dummy_user',
          'ダミーデータ',
          rec.display_name,
          to_char(d, 'YYYY/MM/DD'),
          d,
          net,
          tax,
          gross,
          party,
          guest,
          unit,
          '[ダミー] ' || rec.display_name || ' ' || to_char(d, 'YYYY-MM-DD'),
          payload,
          created_ts;

        total := total + 1;
      end loop;

      d := d + 1;
    end loop;

    store_partition_key := rec.store_partition_key;
    receipt_table := rec.receipt_table;
    inserted_count := total;
    return next;
  end loop;
end;
$$;

comment on function public.seed_dummy_store_receipts(text, integer) is
  '全店舗に過去 p_years_back 年分〜本日（JST）までのダミー売上を投入する。再実行時は既存ダミーを置き換える。';
