-- マルゴエスのPOS電子ジャーナル原本は、ファイル名先頭の店舗コード1022を使う。
-- Journal Reportが小文字化して保存する店舗キーに合わせ、marugosへ明示的に割り当てる。
-- 既に別店舗へ割り当てられていた場合は黙って上書きしない。

insert into public.pos_journal_store_codes (
  store_code,
  store_partition_key,
  store_name,
  note
)
values (
  '1022',
  'marugos',
  'マルゴエス',
  '2025-12〜2026-08の実POS電子ジャーナル原本（ファイル名先頭1022）で確認'
)
on conflict (store_code) do update
set
  store_name = excluded.store_name,
  note = excluded.note,
  updated_at = now()
where public.pos_journal_store_codes.store_partition_key = excluded.store_partition_key;

do $$
begin
  if not exists (
    select 1
    from public.pos_journal_store_codes
    where store_code = '1022'
      and store_partition_key = 'marugos'
      and store_name = 'マルゴエス'
  ) then
    raise exception
      'POS store code 1022 is already assigned to a different store';
  end if;
end;
$$;
