-- 検索インデックス line_room_receipt_search のオーファン（幽霊）行を一括削除。
-- 本体レシート削除時にインデックスを消していなかったため、本体に存在しない行が
-- 売上検索に出続け、削除しても「レシートが無い」となる問題（barpelota 2026-05-30 等）の是正。
-- 実レシート（本体テーブル）には一切触れず、本体に紐づかないインデックス行のみ削除する。

do $$
declare
  t text;
begin
  for t in
    select distinct receipt_table
    from public.line_room_receipt_search
    where receipt_table is not null
      and btrim(receipt_table) <> ''
  loop
    -- 対応する本体テーブルが存在しない場合はスキップ（誤削除防止）
    if to_regclass('public.' || t) is null then
      continue;
    end if;

    -- ① receipt_row_id があるのに本体に該当 id が無い行を削除
    execute format(
      'delete from public.line_room_receipt_search s
         where s.receipt_table = %L
           and s.receipt_row_id is not null
           and not exists (select 1 from public.%I b where b.id = s.receipt_row_id)',
      t, t
    );

    -- ② receipt_row_id が無い旧行は line_message_id で本体照合し、無ければ削除
    execute format(
      'delete from public.line_room_receipt_search s
         where s.receipt_table = %L
           and s.receipt_row_id is null
           and s.line_message_id is not null
           and not exists (select 1 from public.%I b where b.line_message_id = s.line_message_id)',
      t, t
    );
  end loop;
exception when others then
  raise notice 'receipt search orphan cleanup skipped: %', sqlerrm;
end;
$$;
