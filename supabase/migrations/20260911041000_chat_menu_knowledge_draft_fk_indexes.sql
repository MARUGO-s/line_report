-- Keep foreign-key lookups and deletion checks bounded as M-talk menu drafts grow.
-- Partial indexes avoid storing null-only entries for optional relationships.

create index if not exists chat_menu_knowledge_drafts_card_message_idx
  on public.chat_menu_knowledge_drafts (card_message_id)
  where card_message_id is not null;

create index if not exists chat_menu_knowledge_drafts_requested_by_idx
  on public.chat_menu_knowledge_drafts (requested_by);

create index if not exists chat_menu_knowledge_drafts_resolved_by_idx
  on public.chat_menu_knowledge_drafts (resolved_by)
  where resolved_by is not null;

create index if not exists chat_menu_knowledge_drafts_result_document_idx
  on public.chat_menu_knowledge_drafts (result_document_id)
  where result_document_id is not null;
