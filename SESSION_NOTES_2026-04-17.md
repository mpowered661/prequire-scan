# Session Notes — 2026-04-17
(untracked — personal reference only, do not commit)

---

## SHIPPED TONIGHT

- Full funnel live end-to-end: landing form → GHL webhook → contact created →
  opportunity → Email 1 fires
- Scanner auto-run from ?url= param deployed to scan.prequire.ai
- Landing page redirect path fixed (/ → /scan path segment added to SCANNER_URL)
- GHL webhook transport fixed: removed `mode: 'no-cors'`, now uses
  `fetch(..., { keepalive: true })` — browser completes POST after navigation
- Email 1 personalization greeting updated (removed empty merge tag)
- staging/ folder deleted from Liquid Web public_html
- Supabase migrations 009, 010, 011 confirmed applied

---

## KNOWN OUTSTANDING (next session)

### BLOCKER — do not send real traffic until fixed
- **app.prequire.ai/signup renders blank** — unknown root cause (console errors?
  404? missing route? JS exception?). Every scanner CTA points here. Must diagnose
  and fix before any real lead traffic is sent.

### Minor / cosmetic
- "Update Opportunity Stage → Scan Delivered" GHL workflow step not moving opps
  between pipeline stages — configured but not firing correctly

### Unbuilt features
- Emails 2–5 of GHL nurture sequence — sequence currently ends after Email 1
- PDF report feature — referenced in landing page FAQ copy but does not exist
- ICP decision not made — first-10-users outreach and demo script blocked on this

---

## Environment / credential gotchas

- **cPanel API**: always use IP `67.227.157.164:2083`, NOT `prequire.ai:2083`
  (hostname returns 403). Token in `prequire-project/.env.deploy`.
- **Vercel repo is public** — required for Hobby plan to deploy commits from
  non-owner GitHub accounts. Do not make private without upgrading to Pro.
- **Scanner .env.local is NOT in git** — covered by `.env*` in .gitignore.
  If repo is cloned fresh, env vars must be re-added manually or via Vercel dashboard.
- **Supabase**: project `emqpoxnjfqxopxwjkweh` shared by scanner and dashboard.
- **PHP 8.1.31 on Liquid Web**: use `catch (Throwable $e)`, not `catch (Exception $e)`.
- **Apache strips Authorization header** on Liquid Web — all PHP API endpoints use
  3-location auth header check.

---

## Loose ends Claude Code flagged but we didn't address

- `console.log` debug statements still in `lib/supabase/scanLeads.ts` (lines 30, 34) —
  logs full insert payload + result to Vercel function logs on every scan. Harmless, noisy.
- Scanner still using `claude-sonnet-4-5` in `app/api/scan/route.ts` — upgrade to
  `claude-opus-4-6` optional.
- No rate limiting on `/api/scan` — open to abuse at scale, low priority for now.
- Cloudflare cache purge after landing page deploys is manual — no automation.
