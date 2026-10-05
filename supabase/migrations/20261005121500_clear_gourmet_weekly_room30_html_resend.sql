-- One-shot ops: allow re-post of gourmet weekly card (HTML「週報を開く」) to M-talk room 30.
-- Prior send had PDF (messages 971/972). After gourmet #43 Pages host, resend card without PDF.
-- Scope: ONLY chat_group_id = 30 and this week's gourmet-weekly key (does not touch room 5).
delete from public.chat_alert_dispatches
where chat_group_id = 30
  and dedupe_key like 'gourmet-weekly:89831708-aeac-4d1d-a345-8b345579a27f:2026-10-05%';
