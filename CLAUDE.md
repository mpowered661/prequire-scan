@AGENTS.md

## Coding Philosophy

### Structure prompts like acceptance criteria, not task descriptions

Learned from the AEO Readiness Check build (2026-05-27): prompts that include
**itemized coverage targets, per-module scope, and explicit pass criteria** produce
substantially better outputs than loose descriptions. The difference is not marginal.

Apply this structure to every feature prompt in this project:

```
Feature: [name]
Modules to build: [list with file paths]
Acceptance criteria per module:
  - [module]: [what done looks like, what tests must pass]
Test scope: [which functions, what fixture types, how many tests minimum]
Verify step: [the exact curl/command that confirms it works end-to-end]
```

**Why it works:** Structure forces agreement on scope before a line is written.
It eliminates "I assumed you meant..." on both sides. It also makes mid-build
corrections cheap — a criteria mismatch surfaces in planning, not after 200 lines.

**When to skip it:** One-off scripts, pure refactors with no new behavior,
hotfixes where the broken behavior is already defined by a failing test.

## Security Debt

### scan_results and scan_leads RLS hardening

**Status: RESOLVED 2026-07-03.** Both tables now have RLS enabled with no
anon policies (deny-all; service-role only), exactly per the recommended fix
below. `scan_results` was hardened in an earlier pass; `scan_leads` was closed
2026-07-03 via Supabase migration `enable_rls_scan_leads` (applied during the
full-system audit — verified in pg_catalog and via security advisors).

**Original problem (for the record):** Both tables had RLS **disabled**.
- Writes were safe: all inserts use the service role key (server-side only).
- Reads were **not protected**: any client holding the Supabase anon key could
  `SELECT *` and enumerate all scanned URLs and scores with no filter required.
- Risk level was **medium** — CORRECTION (2026-07-03): the original "no PII in
  these tables" claim was wrong. `scan_results` contains `email` and
  `ghl_contact_id` columns, and `scan_leads` contains `email` and `ip_address`.
  The exposure was PII-bearing, which makes the (now applied) fix more
  important, not less.

**Recommended fix:**
```sql
ALTER TABLE public.scan_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scan_leads   ENABLE ROW LEVEL SECURITY;
-- No anon SELECT policies — all reads route through server-side code (service key).
-- Service role bypasses RLS by default; no explicit grant needed for server routes.
```

Route all reads through Next.js server components / API routes using `SUPABASE_SERVICE_ROLE_KEY`.
Do not add anon SELECT policies — RLS cannot enforce "must filter by check_id", so an
anon policy still allows full table enumeration. Deny at DB layer, filter at API layer.

**Note:** `aeo_readiness_checks` (migration 003) was built correctly with RLS enabled
from day one. Use that table as the pattern when hardening these two.
