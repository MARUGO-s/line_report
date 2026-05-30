-- 検索インデックス line_room_receipt_search のオーファン一括削除（v2 / 取りこぼし是正）。
-- 20260531120000 の版は存在チェックに to_regclass('public.'||t) を使っており、識別子が
-- 小文字化されるため大文字を含むテーブル（line_receipt__marugoD / line_receipt__marugoS）を
-- 「存在しない」と誤判定してスキップしていた。format('public.%I', t) で正しく引用して再実行する。
-- 実レシート（本体）には触れず、本体に紐づかないインデックス行のみ削除する。

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
    begin
      -- 識別子を正しく引用（大文字混在テーブル名も判定できる）
      if to_regclass(format('public.%I', t)) is null then
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
    exception when others then
      -- 1テーブルの失敗で他テーブルの掃除を止めない
      raise notice 'orphan cleanup v2 skipped for %: %', t, sqlerrm;
    end;
  end loop;
end;
$$;
