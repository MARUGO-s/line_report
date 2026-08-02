-- store_knowledge_documents の source_type CHECK 制約に 'line_post' を追加

alter table public.store_knowledge_documents
  drop constraint if exists store_knowledge_documents_source_type_check;

alter table public.store_knowledge_documents
  add constraint store_knowledge_documents_source_type_check
  check (source_type in ('manual', 'upload', 'ai_insight', 'line_post'));
