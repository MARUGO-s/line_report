-- 電子ジャーナルの「レジ店舗コード → 店舗」対応をDBで持てるようにする。
--
-- これまで対応表はコード内の POS_JOURNAL_STORE_CODE_MAP だけで、店舗を
-- 増やすたびにデプロイが要った。M-talk から .lzh を取り込めるようにするに
-- あたり、店舗コードが分かった時点で即使えるよう insert で足せる形にする。
--
-- コード内の定数は残す。この表が空でも 1015 は従来どおり動く（後方互換）。
-- 解決順は「コード内の定数 → この表」。

create table if not exists public.pos_journal_store_codes (
  store_code text primary key
    constraint pos_journal_store_codes_code_check check (store_code ~ '^[0-9]{4}$'),
  store_partition_key text not null
    constraint pos_journal_store_codes_key_check check (btrim(store_partition_key) <> ''),
  store_name text not null
    constraint pos_journal_store_codes_name_check check (btrim(store_name) <> ''),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.pos_journal_store_codes is
  'LZHファイル名の先頭4桁(レジの店舗コード)と店舗の対応。M-talkからの取込と管理画面の両方が参照する。';
comment on column public.pos_journal_store_codes.store_partition_key is
  'pos_journal_files.store_partition_key と揃える。room_summary_settings.receipt_report_store_partition_key と同じ値。';

-- 業務データそのものなので一般利用者には触らせない。service_role だけ。
alter table public.pos_journal_store_codes enable row level security;
revoke all on table public.pos_journal_store_codes from public, anon, authenticated;
grant select, insert, update, delete on table public.pos_journal_store_codes to service_role;

-- 既存の定数と同じ内容を種として入れておく（重複しても壊れない）。
insert into public.pos_journal_store_codes (store_code, store_partition_key, store_name, note)
values ('1015', 'bistrocavacava', 'Bistro CAVACAVA', 'POS_JOURNAL_STORE_CODE_MAP と同内容の種データ')
on conflict (store_code) do nothing;

-- 参照用。store_partition_key から逆引きしたい場面があるため。
create index if not exists idx_pos_journal_store_codes_partition
  on public.pos_journal_store_codes (store_partition_key);
