-- LINEで配布する固定テンプレートファイル。
-- ファイル本体はline_file_templates.content_base64に保持し、Edge Functionから配布する。

create table if not exists public.line_file_templates (
  template_key text primary key,
  filename text not null,
  content_type text not null,
  content_base64 text not null,
  description text,
  updated_at timestamptz not null default now()
);

alter table public.line_file_templates enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'line_file_templates'
      and policyname = 'Service role line_file_templates'
  ) then
    create policy "Service role line_file_templates"
      on public.line_file_templates
      for all
      using (auth.role() = 'service_role')
      with check (auth.role() = 'service_role');
  end if;
end $$;
