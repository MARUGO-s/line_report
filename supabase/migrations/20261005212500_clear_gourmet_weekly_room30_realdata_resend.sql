-- One-shot ops: allow re-post of gourmet weekly card (real-data HTML) to M-talk room 30.
-- Prior HTML resend was message 973 (stub Pages content). After gourmet #44 real-data rebuild, resend card without PDF.
-- Scope: ONLY chat_group_id = 30 and this week's gourmet-weekly key (does not touch other rooms).
delete from public.chat_alert_dispatches
where chat_group_id = 30
  and dedupe_key like 'gourmet-weekly:89831708-aeac-4d1d-a345-8b345579a27f:2026-10-05%';
