@AGENTS.md

## Security Debt

### scan_results and scan_leads RLS hardening

**Status:** Out of scope — document and address separately.

**Problem:** Both `scan_results` and `scan_leads` tables have RLS **disabled**.
- Writes are safe: all inserts use the service role key (server-side only).
- Reads are **not protected**: any client holding the Supabase anon key can
  `SELECT *` and enumerate all scanned URLs and scores with no filter required.
- Risk level: **medium** — no PII in these tables, but exposes customer
  scanning patterns and could leak competitive intelligence.

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
