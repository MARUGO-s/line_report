-- Disable webhook pushes (reservation today, gmail alerts, dome weekly) for all rooms
-- associated with Bistro CAVACAVA other than the active "Cava Cava" group.
UPDATE public.room_summary_settings
SET
  gmail_reservation_alert_enabled = false,
  today_reservation_alert_enabled = false,
  dome_weekly_enabled = false
WHERE
  (
    receipt_report_store_partition_key = 'bistrocavacava'
    OR LOWER(room_name) = 'bistro cava cava'
    OR room_name = 'サヴァサヴァ'
  )
  AND room_name != 'Cava Cava';
