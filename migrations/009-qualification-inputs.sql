-- Immutable QualificationInput artifact: one per completed scan observation.
--
-- RLS is enabled with service-role policies only, following 008's explicit
-- style. Append-only by construction: NO update policy and NO delete policy is
-- defined, so even the service role cannot rewrite or remove a stored artifact
-- through the data API. A changed observation requires a NEW scan_id.
--
-- NOT APPLIED. Numbering note: this repository's migrations directory is known
-- to be an incomplete record of the live schema (003 is absent, and
-- aeo_readiness_checks is written by app/api/aeo-readiness-check/route.ts with
-- no migration here). 009 is the next free number IN THIS DIRECTORY only.
-- Confirm against the live schema before applying.
--
-- Deliberately NOT dependent on migration 008: no foreign key to
-- page_observations, and no reference to site_scans, whose 008 foreign key is
-- itself invalid as written. This table stands alone precisely so the trust
-- path does not inherit the unfinished Tranche D persistence work.

create table if not exists public.qualification_inputs (
  scan_id uuid primary key,
  input_schema_version text not null,
  qualification_version text not null,
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  -- The payload must be a JSON object carrying the scan identity it belongs to,
  -- so a row cannot be read under the wrong scan. Defence in depth: the
  -- application validator is the boundary, this catches a writer that bypasses it.
  constraint qualification_inputs_payload_is_object
    check (jsonb_typeof(payload) = 'object'),
  constraint qualification_inputs_payload_carries_scan_id
    check (payload ->> 'scanId' = scan_id::text),
  -- All four evidence collections must be present as arrays. An ABSENT
  -- collection is not an observed empty one, and only a complete observation
  -- may be stored.
  constraint qualification_inputs_payload_collections_present
    check (
      jsonb_typeof(payload -> 'scanUrls') = 'array'
      and jsonb_typeof(payload -> 'pageObservations') = 'array'
      and jsonb_typeof(payload -> 'linkTargets') = 'array'
      and jsonb_typeof(payload -> 'linkRelationships') = 'array'
      and jsonb_typeof(payload -> 'coverage') = 'object'
    )
);

alter table public.qualification_inputs enable row level security;

create policy "service role can insert qualification inputs"
  on public.qualification_inputs
  for insert
  to service_role
  with check (true);

create policy "service role can read qualification inputs"
  on public.qualification_inputs
  for select
  to service_role
  using (true);

-- No UPDATE policy and no DELETE policy by design. Immutability is enforced by
-- the absence of a write path, not by convention.
