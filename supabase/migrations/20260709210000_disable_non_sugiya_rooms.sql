-- Disable webhook pushes (reservation today, gmail alerts, dome weekly) for all rooms
-- associated with Margot Second other than the active "今月は杉谷" group.
UPDATE public.room_summary_settings
SET
  gmail_reservation_alert_enabled = false,
  today_reservation_alert_enabled = false,
  dome_weekly_enabled = false
WHERE
  (
    receipt_report_store_partition_key = 'marugosecond'
    OR LOWER(room_name) = 'marugo second'
    OR room_name = 'マルゴセカンド'
  )
  AND room_name != '今月は杉谷';
