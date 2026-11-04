// Test environment defaults. The privileged Supabase client now validates its
// configuration at call time (see lib/supabase/serviceClient.ts); unit tests
// mock @supabase/supabase-js but still need these present so getServiceClient()
// reaches the mocked createClient. Dummy values only — never real credentials.
// Tests that exercise the missing-configuration path delete these explicitly.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
