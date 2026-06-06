-- 予約変更（モディファイ）対応。
-- 【予約変更】メールは「既存予約の変更通知」。新規予約として来店回数を +1 せず、
-- 元の予約レコード（同じお客様＝氏名+電話 ＋ 予約番号で照合、無ければ直近の未キャンセル予約）を見つけて
-- 日時(visit_at)・種別・detail を上書きする（カレンダーに重複を作らない）。
-- 来店回数・キャンセル回数・来店履歴は据え置き（変更は ±0）。

-- (1) 変更判定: キャンセルでなく、種別/detail に「変更・修正」があれば true。
create or replace function public.reservation_visit_looks_modified(
  p_reservation_type text,
  p_reservation_detail text
)
returns boolean
language plpgsql
immutable
as $$
declare
  v_type text := coalesce(trim(p_reservation_type), '');
  v_detail text := coalesce(trim(p_reservation_detail), '');
  v_parsed jsonb;
  v_key text;
begin
  -- キャンセルが最優先（キャンセルは「変更」ではない）。
  if public.reservation_visit_looks_cancelled(p_reservation_type, p_reservation_detail) then
    return false;
  end if;
  if v_type ~* '(変更|修正)' then
    return true;
  end if;
  if v_detail like '{%' then
    begin
      v_parsed := v_detail::jsonb;
    exception when others then
      v_parsed := null;
    end;
    if v_parsed is not null then
      foreach v_key in array array['eventType','status','action','mailType','subject','title','summary'] loop
        if coalesce(v_parsed ->> v_key, '') ~* '(変更|修正)' then
          return true;
        end if;
      end loop;
      return false;
    end if;
  end if;
  if v_detail ~* '予約変更' then
    return true;
  end if;
  return false;
end;
$$;

-- (2) 記録RPC: 変更分岐を追加（新規=+1 / キャンセル=-1 / 変更=据え置き＆元予約を上書き）。
create or replace function public.record_partner_reservation_visit(
  p_partner text,
  p_event_table regclass,
  p_summary_table regclass,
  p_gmail_message_id text,
  p_customer_name text,
  p_customer_phone text,
  p_visit_at timestamptz default null,
  p_reservation_type text default null,
  p_reservation_detail text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_phone text;
  v_visit_at timestamptz;
  v_cancelled boolean;
  v_modified boolean;
  v_reservation_no text;
  v_row_count integer;
  v_visit_count integer;
  v_cancelled_count integer;
  v_recent jsonb;
  v_type text;
  v_detail text;
  v_sql text;
begin
  if nullif(trim(p_gmail_message_id), '') is null then
    return null;
  end if;
  if p_partner not in ('tabelog', 'ikyu') then
    return null;
  end if;

  v_name := nullif(trim(p_customer_name), '');
  v_phone := nullif(trim(p_customer_phone), '');
  if v_name is null or v_phone is null then
    return null;
  end if;

  v_visit_at := coalesce(p_visit_at, now());
  v_type := nullif(trim(coalesce(p_reservation_type, '')), '');
  v_detail := nullif(trim(coalesce(p_reservation_detail, '')), '');
  v_cancelled := public.reservation_visit_looks_cancelled(v_type, v_detail);
  v_modified := public.reservation_visit_looks_modified(v_type, v_detail);

  if v_modified then
    -- ── 予約変更: 元予約を照合して上書き（来店回数・履歴は据え置き）──
    v_reservation_no := null;
    if v_detail like '{%' then
      begin
        v_reservation_no := nullif(trim(coalesce((v_detail::jsonb) ->> 'reservationNo', '')), '');
      exception when others then
        v_reservation_no := null;
      end;
    end if;

    v_row_count := 0;
    -- a) 同じお客様 ＋ 予約番号 で特定して上書き
    if v_reservation_no is not null then
      v_sql := format(
        $f$
        with cand as (
          select id from %1$s
          where customer_name = $1 and customer_phone = $2
            and gmail_message_id <> $3
            and coalesce(manual_hidden, false) = false
            and not public.reservation_visit_looks_cancelled(reservation_type, reservation_detail)
            and reservation_detail like '{%%'
            and (reservation_detail::jsonb ->> 'reservationNo') = $4
          order by created_at desc, id desc
          limit 1
        )
        update %1$s t
          set visit_at = $5, reservation_type = $6, reservation_detail = $7
          from cand where t.id = cand.id
        $f$,
        p_event_table::text
      );
      execute v_sql using v_name, v_phone, p_gmail_message_id, v_reservation_no, v_visit_at, v_type, v_detail;
      get diagnostics v_row_count = row_count;
    end if;

    -- b) 番号で特定できなければ、お客様の直近の未キャンセル予約を上書き（フォールバック）
    if v_row_count = 0 then
      v_sql := format(
        $f$
        with cand as (
          select id from %1$s
          where customer_name = $1 and customer_phone = $2
            and gmail_message_id <> $3
            and coalesce(manual_hidden, false) = false
            and not public.reservation_visit_looks_cancelled(reservation_type, reservation_detail)
          order by created_at desc, id desc
          limit 1
        )
        update %1$s t
          set visit_at = $4, reservation_type = $5, reservation_detail = $6
          from cand where t.id = cand.id
        $f$,
        p_event_table::text
      );
      execute v_sql using v_name, v_phone, p_gmail_message_id, v_visit_at, v_type, v_detail;
      get diagnostics v_row_count = row_count;
    end if;

    -- c) 元予約が見つからない場合（通常は起きない）、カレンダー表示のためイベントだけ記録（カウントはしない）
    if v_row_count = 0 then
      v_sql := format(
        'insert into %s (gmail_message_id, customer_name, customer_phone, visit_at, reservation_type, reservation_detail) values ($1, $2, $3, $4, $5, $6) on conflict (gmail_message_id) do nothing',
        p_event_table::text
      );
      execute v_sql using p_gmail_message_id, v_name, v_phone, v_visit_at, v_type, v_detail;
    end if;
    -- 来店回数 / キャンセル回数 / 来店履歴 は変更しない（据え置き）。

  else
    -- ── 新規 / キャンセル: 従来どおり ──
    v_sql := format(
      'insert into %s (gmail_message_id, customer_name, customer_phone, visit_at, reservation_type, reservation_detail) values ($1, $2, $3, $4, $5, $6) on conflict (gmail_message_id) do nothing',
      p_event_table::text
    );
    execute v_sql using p_gmail_message_id, v_name, v_phone, v_visit_at, v_type, v_detail;
    get diagnostics v_row_count = row_count;

    insert into public.reservation_customer_visit_history (
      partner, gmail_message_id, customer_name, customer_phone,
      visit_at, reservation_type, reservation_detail, is_cancelled
    ) values (
      p_partner, p_gmail_message_id, v_name, v_phone,
      v_visit_at, v_type, v_detail, v_cancelled
    )
    on conflict (partner, gmail_message_id) do nothing;

    if v_row_count > 0 then
      if v_cancelled then
        v_sql := format(
          $f$
          insert into %s (customer_name, customer_phone, visit_count, last_visit_at, created_at, updated_at)
          values ($1, $2, 0, null, now(), now())
          on conflict (customer_name, customer_phone) do update
            set visit_count = greatest(0, %s.visit_count - 1),
                updated_at = now()
          $f$,
          p_summary_table::text,
          p_summary_table::text
        );
        execute v_sql using v_name, v_phone;
      else
        v_sql := format(
          $f$
          insert into %s (customer_name, customer_phone, visit_count, last_visit_at, created_at, updated_at)
          values ($1, $2, 1, $3, now(), now())
          on conflict (customer_name, customer_phone) do update
            set visit_count = %s.visit_count + 1,
                last_visit_at = greatest(
                  coalesce(%s.last_visit_at, excluded.last_visit_at),
                  excluded.last_visit_at
                ),
                updated_at = now()
          $f$,
          p_summary_table::text,
          p_summary_table::text,
          p_summary_table::text
        );
        execute v_sql using v_name, v_phone, v_visit_at;
      end if;
    end if;
  end if;

  -- 現在の集計を返す（変更時は据え置きの値が返る）。
  v_sql := format(
    'select visit_count from %s where customer_name = $1 and customer_phone = $2 limit 1',
    p_summary_table::text
  );
  execute v_sql into v_visit_count using v_name, v_phone;
  v_visit_count := coalesce(v_visit_count, 0);

  select count(*)::integer
    into v_cancelled_count
  from public.reservation_customer_visit_history h
  where h.partner = p_partner
    and h.customer_name = v_name
    and h.customer_phone = v_phone
    and h.is_cancelled = true;

  v_recent := public.get_reservation_recent_visits_json(
    p_partner, v_name, v_phone, p_gmail_message_id, 5
  );

  return jsonb_build_object(
    'visit_count', v_visit_count,
    'cancelled_count', coalesce(v_cancelled_count, 0),
    'recent_visits', v_recent
  );
end;
$$;
