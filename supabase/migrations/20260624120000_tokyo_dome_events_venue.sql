-- ドームシティ各会場（カナデビアホール等）のイベントを tokyo_dome_events で扱うため venue を追加。
-- 主キーを (event_date, title) → (event_date, venue, title) に張り替え（会場が異なれば同日同名でも別行）。
-- 冪等: 既に適用済みでもエラーにならない（GitHub統合の再適用に耐える）。
alter table public.tokyo_dome_events
  add column if not exists venue text not null default 'tokyo-dome';

comment on column public.tokyo_dome_events.venue is '会場: tokyo-dome（東京ドーム本体）/ kanadevia（カナデビアホール）等。同日同名でも会場が異なれば別行。';

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.tokyo_dome_events'::regclass and contype = 'p'
      and array_length(conkey, 1) = 2
  ) then
    alter table public.tokyo_dome_events drop constraint tokyo_dome_events_pkey;
    alter table public.tokyo_dome_events add constraint tokyo_dome_events_pkey primary key (event_date, venue, title);
  end if;
end $$;
