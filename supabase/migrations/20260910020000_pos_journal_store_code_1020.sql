-- Bistro CAVACAVA の2025年分POS原本で使われていた旧店舗コード1020を登録する。
-- 本番 pos_journal_files では、1020の35原本がすべてbistrocavacavaとして保存済み。
-- 現行コード1015と同じ店舗として扱い、M-talk／電子ジャーナル再取込を可能にする。

insert into public.pos_journal_store_codes (
  store_code,
  store_partition_key,
  store_name,
  note
)
values (
  '1020',
  'bistrocavacava',
  'Bistro CAVACAVA',
  '2025年分の保存済みPOS原本で確認した旧店舗コード'
)
on conflict (store_code) do update
set
  store_name = excluded.store_name,
  note = excluded.note,
  updated_at = now()
where public.pos_journal_store_codes.store_partition_key = excluded.store_partition_key;

-- 既に別店舗へ割り当てられていた場合は、黙って上書きせずデプロイを止める。
do $$
begin
  if not exists (
    select 1
    from public.pos_journal_store_codes
    where store_code = '1020'
      and store_partition_key = 'bistrocavacava'
      and store_name = 'Bistro CAVACAVA'
  ) then
    raise exception
      'POS store code 1020 is already assigned to a different store';
  end if;
end;
$$;
