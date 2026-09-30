create table if not exists public.page_observations (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.site_scans(id) on delete cascade,
  requested_url text not null,
  final_url text not null,
  engine text not null check (engine in ('extraction_resilience', 'structured_data', 'content_delivery', 'meta_tags')),
  engine_version text not null,
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  observation jsonb,
  status text not null check (status in ('ok', 'failed')),
  error_reason text,
  observed_at timestamptz not null,
  scope text not null check (scope = 'page'),
  created_at timestamptz not null default now(),
  unique (scan_id, requested_url, engine)
);

alter table public.page_observations enable row level security;

create policy "service role can insert page observations"
  on public.page_observations
  for insert
  to service_role
  with check (true);

create policy "service role can read page observations"
  on public.page_observations
  for select
  to service_role
  using (true);

alter table public.scan_urls
  add column if not exists analysis_state text not null default 'not_attempted'
  check (analysis_state in ('not_attempted', 'partial', 'complete', 'failed'));

alter table public.scan_urls
  add constraint scan_urls_analyzed_requires_complete
  check (analyzed = false or analysis_state = 'complete');

-- ── Amendment D2: durable evidence minimization ──────────────────────────────
-- The enforcement boundary is the application-side projection registry
-- (lib/site-discovery/evidence-projection.ts, MAX_DURABLE_OBSERVATION_BYTES).
-- These constraints are defence in depth, not the boundary: they catch a writer
-- that bypasses the projector. They deliberately do NOT attempt to inspect
-- evidence semantics, which PostgreSQL cannot do safely.

-- A successful observation must carry a projected object; a failed one carries none.
alter table public.page_observations
  add constraint page_observations_status_observation_agree
  check (
    (status = 'ok' and observation is not null and jsonb_typeof(observation) = 'object')
    or
    (status = 'failed' and observation is null and error_reason is not null)
  );

-- Every stored observation must be stamped by the projection registry. A raw
-- engine result has no such key, so an unprojected write is rejected.
alter table public.page_observations
  add constraint page_observations_requires_projection
  check (observation is null or observation ? 'evidence_projection_version');

-- Size backstop. The application ceiling is 4096 bytes of JSON.stringify output;
-- jsonb re-serializes, so the database bound is set above it to avoid rejecting
-- a payload the projector already accepted. Tripping this indicates a bypass.
alter table public.page_observations
  add constraint page_observations_durable_size_backstop
  check (observation is null or octet_length(observation::text) <= 8192);
