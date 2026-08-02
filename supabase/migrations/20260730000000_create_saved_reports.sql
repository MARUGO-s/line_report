-- Create saved_reports table for storing POS journal reports and AI analysis
CREATE TABLE IF NOT EXISTS public.saved_reports (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    period TEXT,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS and grant access for anon users
ALTER TABLE public.saved_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public read access" ON public.saved_reports;
CREATE POLICY "Allow public read access" ON public.saved_reports FOR SELECT USING (true);

DROP POLICY IF EXISTS "Allow public insert access" ON public.saved_reports;
CREATE POLICY "Allow public insert access" ON public.saved_reports FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Allow public update access" ON public.saved_reports;
CREATE POLICY "Allow public update access" ON public.saved_reports FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Allow public delete access" ON public.saved_reports;
CREATE POLICY "Allow public delete access" ON public.saved_reports FOR DELETE USING (true);
