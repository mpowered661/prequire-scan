-- Site discovery inventory and coverage manifests.
-- RLS is enabled with no anon policies; service-role access only.
-- Append-only: no UPDATE/DELETE policies are defined.

create table if not exists site_scans (
  scan_id uuid primary key,
  seed_url text not null,
  domain text not null,
  scan_mode text not null default 'prospect_observation'
    check (scan_mode in ('prospect_observation', 'authorized_customer')),
  status text not null check (status in ('complete', 'partial', 'aborted')),
  manifest jsonb not null,
  discovery_version text not null,
  normalization_version text not null,
  started_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists scan_urls (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references site_scans(scan_id) on delete cascade,
  url_raw text not null,
  url_normalized text,
  discovery_method text not null,
  discovered_from_url text,
  sitemap_source_url text,
  link_depth int,
  in_scope boolean not null,
  excluded_reason text,
  fetch_state text not null default 'not_attempted',
  http_status int,
  analyzed boolean not null default false,
  first_seen_at timestamptz not null default now(),
  unique (scan_id, url_normalized),
  check (analyzed = false or fetch_state = 'fetched')
);

alter table site_scans enable row level security;
alter table scan_urls enable row level security;
