-- Link integrity evidence for site discovery.
-- RLS is enabled with no anon policies; service-role access only.
-- Append-only: no UPDATE/DELETE policies are defined.

create table if not exists scan_links (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references site_scans(scan_id) on delete cascade,
  source_url text not null,
  href_raw text not null,
  target_url_normalized text,
  anchor_text text,
  placement text not null check (placement in ('nav','footer','body','unknown')),
  is_internal boolean not null,
  eligible_for_check boolean not null,
  exclusion_reason text,
  observed_at timestamptz not null default now()
);

create table if not exists scan_link_targets (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references site_scans(scan_id) on delete cascade,
  target_url_normalized text not null,
  check_state text not null check (check_state in ('checked','unchecked')),
  unchecked_reason text,
  classification text check (classification in
    ('healthy','redirected','broken_4xx','server_failure_5xx','blocked','timeout','undeterminable')),
  http_status int,
  redirect_target_url text,
  redirect_left_origin boolean,
  redirect_hops int,
  method_used text check (method_used in ('HEAD','GET')),
  response_ms int,
  source_link_count int not null,
  checked_at timestamptz,
  unique (scan_id, target_url_normalized),
  check (check_state = 'checked' or classification is null)
);

alter table scan_links enable row level security;
alter table scan_link_targets enable row level security;
