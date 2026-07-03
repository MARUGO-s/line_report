-- 予約変更メールで reservationNo が取れない場合のフォールバックを保守的にする。
-- 氏名+電話だけで「直近の未キャンセル予約」を上書きすると、別店舗・別予約を誤更新する危険があるため、
-- 候補が1件に一意化できる時だけ上書きする。候補が複数ある場合はイベントだけ記録し、回数は据え置く。

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
  v_store_name text;
  v_fallback_candidates integer;
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
  v_reservation_no := public.reservation_visit_extract_reservation_no(v_detail);
  v_store_name := public.reservation_visit_store_name(v_detail);

  if v_modified then
    -- 予約変更: 元予約を照合して上書き（来店回数・履歴は据え置き）
    v_row_count := 0;
    v_fallback_candidates := 0;

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
            and public.reservation_visit_extract_reservation_no(reservation_detail) = $4
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

    -- reservationNo が取れない変更メールは危険なので、
    -- 同一店舗まで絞った候補が 1 件のときだけ上書きする。
    if v_row_count = 0 then
      v_sql := format(
        $f$
        select count(*)::integer
        from %1$s
        where customer_name = $1 and customer_phone = $2
          and gmail_message_id <> $3
          and coalesce(manual_hidden, false) = false
          and not public.reservation_visit_looks_cancelled(reservation_type, reservation_detail)
          and ($4 is null or public.reservation_visit_store_name(reservation_detail) = $4)
        $f$,
        p_event_table::text
      );
      execute v_sql into v_fallback_candidates using v_name, v_phone, p_gmail_message_id, v_store_name;
    end if;

    if v_row_count = 0 and v_fallback_candidates = 1 then
      v_sql := format(
        $f$
        with cand as (
          select id from %1$s
          where customer_name = $1 and customer_phone = $2
            and gmail_message_id <> $3
            and coalesce(manual_hidden, false) = false
            and not public.reservation_visit_looks_cancelled(reservation_type, reservation_detail)
            and ($4 is null or public.reservation_visit_store_name(reservation_detail) = $4)
          order by created_at desc, id desc
          limit 1
        )
        update %1$s t
          set visit_at = $5, reservation_type = $6, reservation_detail = $7
          from cand where t.id = cand.id
        $f$,
        p_event_table::text
      );
      execute v_sql using v_name, v_phone, p_gmail_message_id, v_store_name, v_visit_at, v_type, v_detail;
      get diagnostics v_row_count = row_count;
    end if;

    if v_row_count = 0 then
      v_sql := format(
        'insert into %s (gmail_message_id, customer_name, customer_phone, visit_at, reservation_type, reservation_detail) values ($1, $2, $3, $4, $5, $6) on conflict (gmail_message_id) do nothing',
        p_event_table::text
      );
      execute v_sql using p_gmail_message_id, v_name, v_phone, v_visit_at, v_type, v_detail;
    end if;

  else
    v_row_count := 0;

    -- 同じ reservationNo の同種通知（新規の再送 / キャンセルの再送）は idempotent とみなし、既存行を上書きして回数は据え置く。
    if v_reservation_no is not null then
      v_sql := format(
        $f$
        with cand as (
          select id from %1$s
          where customer_name = $1 and customer_phone = $2
            and gmail_message_id <> $3
            and coalesce(manual_hidden, false) = false
            and reservation_detail like '{%%'
            and public.reservation_visit_extract_reservation_no(reservation_detail) = $4
            and public.reservation_visit_looks_cancelled(reservation_type, reservation_detail) = $5
          order by created_at desc, id desc
          limit 1
        )
        update %1$s t
          set gmail_message_id = $3,
              visit_at = $6,
              reservation_type = $7,
              reservation_detail = $8
          from cand where t.id = cand.id
        $f$,
        p_event_table::text
      );
      execute v_sql using v_name, v_phone, p_gmail_message_id, v_reservation_no, v_cancelled, v_visit_at, v_type, v_detail;
      get diagnostics v_row_count = row_count;

      if v_row_count > 0 then
        with cand as (
          select id
          from public.reservation_customer_visit_history
          where partner = p_partner
            and customer_name = v_name
            and customer_phone = v_phone
            and gmail_message_id <> p_gmail_message_id
            and is_cancelled = v_cancelled
            and public.reservation_visit_extract_reservation_no(reservation_detail) = v_reservation_no
          order by created_at desc, id desc
          limit 1
        )
        update public.reservation_customer_visit_history h
           set gmail_message_id = p_gmail_message_id,
               visit_at = v_visit_at,
               reservation_type = v_type,
               reservation_detail = v_detail,
               is_cancelled = v_cancelled
          from cand
         where h.id = cand.id;
      end if;
    end if;

    if v_row_count = 0 then
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
  end if;

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
