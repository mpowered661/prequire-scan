-- Migration 002: scan_results table
-- Run in Supabase SQL Editor (project: emqpoxnjfqxopxwjkweh)
-- Stores full AEO scan results for shareable report URLs and Quinn audit delivery

CREATE TABLE IF NOT EXISTS public.scan_results (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id         uuid        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  url             text        NOT NULL,
  overall_score   integer     NOT NULL CHECK (overall_score >= 0 AND overall_score <= 100),
  result_json     jsonb       NOT NULL,
  email           text,
  source          text        NOT NULL DEFAULT 'public',
  ghl_contact_id  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scan_results_scan_id_idx ON public.scan_results (scan_id);
CREATE INDEX IF NOT EXISTS scan_results_created_at_idx ON public.scan_results (created_at DESC);
CREATE INDEX IF NOT EXISTS scan_results_source_idx ON public.scan_results (source);
