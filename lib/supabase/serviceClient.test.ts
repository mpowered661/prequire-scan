import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Regression guard for the Vercel Preview build failure:
//   Error: supabaseKey is required.  (during `next build` page-data collection)
//
// Root cause was module-scope `createClient(url!, SUPABASE_SERVICE_ROLE_KEY!)`
// in the lib/supabase modules: importing a route that pulled them in forced the
// service-role key to exist at build time, which Preview builds do not carry.
//
// These tests pin the fix: (1) the modules import with NO Supabase env set
// (i.e. `next build` can evaluate them), and (2) the privileged client is only
// built when actually used, failing safely with a clear error if unconfigured.

const URL_KEY = 'NEXT_PUBLIC_SUPABASE_URL';
const SVC_KEY = 'SUPABASE_SERVICE_ROLE_KEY';

describe('service-role client lazy initialization (build-time safety)', () => {
  let savedUrl: string | undefined;
  let savedKey: string | undefined;

  beforeEach(() => {
    savedUrl = process.env[URL_KEY];
    savedKey = process.env[SVC_KEY];
    delete process.env[URL_KEY];
    delete process.env[SVC_KEY];
  });

  afterEach(() => {
    if (savedUrl === undefined) delete process.env[URL_KEY];
    else process.env[URL_KEY] = savedUrl;
    if (savedKey === undefined) delete process.env[SVC_KEY];
    else process.env[SVC_KEY] = savedKey;
  });

  it('imports every lib/supabase module without any Supabase env present', async () => {
    // No env set in beforeEach. A module that instantiated the client at import
    // time would throw here — exactly the build-time failure we are preventing.
    await expect(
      Promise.all([
        import('./serviceClient'),
        import('./captureLead'),
        import('./readinessChecks'),
        import('./scanLeads'),
        import('./scanResults'),
      ]),
    ).resolves.toBeDefined();
  });

  it('throws a clear error when the service-role key is missing at call time', async () => {
    const { getServiceClient, __resetServiceClientForTests } = await import('./serviceClient');
    __resetServiceClientForTests();
    process.env[URL_KEY] = 'https://test.supabase.co';
    // SUPABASE_SERVICE_ROLE_KEY deliberately absent.
    expect(() => getServiceClient()).toThrowError(/not configured|SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('never silently returns an unconfigured client', async () => {
    const { getServiceClient, __resetServiceClientForTests } = await import('./serviceClient');
    __resetServiceClientForTests();
    // Neither URL nor key present.
    expect(() => getServiceClient()).toThrow();
  });

  it('builds and memoizes one client when fully configured', async () => {
    const { getServiceClient, __resetServiceClientForTests } = await import('./serviceClient');
    __resetServiceClientForTests();
    process.env[URL_KEY] = 'https://test.supabase.co';
    process.env[SVC_KEY] = 'test-service-role-key';
    const a = getServiceClient();
    const b = getServiceClient();
    expect(a).toBeDefined();
    expect(a).toBe(b); // memoized: same instance, no per-call re-creation
  });
});
