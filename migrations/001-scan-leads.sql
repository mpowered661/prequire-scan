-- Migration 001: scan_leads table
-- Run in Supabase SQL Editor (project: emqpoxnjfqxopxwjkweh)
-- No auth.users FK — this is a public scanner, no login required

CREATE TABLE IF NOT EXISTS public.scan_leads (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  url        text        NOT NULL,
  overall_score integer  NOT NULL CHECK (overall_score >= 0 AND overall_score <= 100),
  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  utm_content  text,
  utm_term     text,
  scanned_at   timestamptz NOT NULL DEFAULT now()
);

-- No RLS needed — server-side inserts use service role key
-- Optional: add index for analytics queries by URL or date
CREATE INDEX IF NOT EXISTS scan_leads_scanned_at_idx ON public.scan_leads (scanned_at DESC);
CREATE INDEX IF NOT EXISTS scan_leads_url_idx ON public.scan_leads (url);
