import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Privileged (service-role) Supabase client — SERVER-SIDE ONLY.
//
// This must never be created at module-import / Next.js build-time evaluation:
// `next build` evaluates route modules to collect page data, and an eager
// client would require SUPABASE_SERVICE_ROLE_KEY to be present in the build
// environment (Preview builds do not carry it, by design — the service-role
// key is Production-only and is never copied into Preview or exposed to the
// browser). So we construct it lazily, inside the server-side execution path,
// and memoize it so repeated calls reuse one instance (same as the previous
// module-scope singleton).
//
// If the runtime configuration is unavailable we throw a clear, descriptive
// error at call time rather than passing `undefined` into createClient — the
// privileged operation fails safely and loudly instead of silently misbehaving.

let cached: SupabaseClient | null = null;

export function getServiceClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'Supabase service client is not configured: NEXT_PUBLIC_SUPABASE_URL and ' +
        'SUPABASE_SERVICE_ROLE_KEY must both be set in the server environment. ' +
        'This client is server-side only and is never initialized at build time.',
    );
  }

  cached = createClient(url, key);
  return cached;
}

// Test-only: clear the memoized client so a test can exercise init behavior
// under different environment conditions. Not used in production paths.
export function __resetServiceClientForTests(): void {
  cached = null;
}
