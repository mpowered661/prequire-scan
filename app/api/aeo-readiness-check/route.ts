import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { buildReport } from '@/lib/aeo-readiness/report-builder';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const ANON_HOURLY  = 3;
const ANON_DAILY   = 10;
const AUTH_HOURLY  = 20;
const AUTH_DAILY   = 100;

function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? '0.0.0.0';
}

function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex');
}

async function checkRateLimit(
  ipHash: string,
  userId: string | null,
): Promise<{ allowed: boolean; reason?: string }> {
  const now = Date.now();
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
  const oneDayAgo  = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  if (userId) {
    const [hourly, daily] = await Promise.all([
      supabase
        .from('aeo_readiness_checks')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('tested_at', oneHourAgo),
      supabase
        .from('aeo_readiness_checks')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('tested_at', oneDayAgo),
    ]);
    if ((hourly.count ?? 0) >= AUTH_HOURLY) {
      return { allowed: false, reason: `Hourly limit reached (${AUTH_HOURLY}/hr). Please wait before running another check.` };
    }
    if ((daily.count ?? 0) >= AUTH_DAILY) {
      return { allowed: false, reason: `Daily limit reached (${AUTH_DAILY}/day). Try again tomorrow.` };
    }
  } else {
    const [hourly, daily] = await Promise.all([
      supabase
        .from('aeo_readiness_checks')
        .select('*', { count: 'exact', head: true })
        .eq('ip_hash', ipHash)
        .gte('tested_at', oneHourAgo),
      supabase
        .from('aeo_readiness_checks')
        .select('*', { count: 'exact', head: true })
        .eq('ip_hash', ipHash)
        .gte('tested_at', oneDayAgo),
    ]);
    if ((hourly.count ?? 0) >= ANON_HOURLY) {
      return { allowed: false, reason: `Rate limit reached (${ANON_HOURLY} checks/hr for anonymous users). Sign up for a Prequire account to run more checks.` };
    }
    if ((daily.count ?? 0) >= ANON_DAILY) {
      return { allowed: false, reason: `Daily limit reached (${ANON_DAILY}/day for anonymous users). Sign up for a Prequire account for higher limits.` };
    }
  }

  return { allowed: true };
}

export async function POST(req: NextRequest) {
  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const rawUrl = body.url;
    if (!rawUrl || typeof rawUrl !== 'string') {
      return NextResponse.json({ error: 'url is required' }, { status: 400 });
    }

    let normalizedUrl: string;
    try {
      const parsed = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
      normalizedUrl = parsed.toString();
    } catch {
      return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
    }

    // Optional JWT auth — unauthenticated requests are accepted but rate-limited more tightly
    let userId: string | null = null;
    const authHeader = req.headers.get('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const { data } = await supabase.auth.getUser(token);
      userId = data.user?.id ?? null;
    }

    const ipHash = hashIp(getClientIp(req));
    const rateLimit = await checkRateLimit(ipHash, userId);
    if (!rateLimit.allowed) {
      return NextResponse.json({ error: rateLimit.reason }, { status: 429 });
    }

    const includeSeo = body.include_seo_bots === true;
    const report = await buildReport(normalizedUrl, { include_seo_bots: includeSeo });

    const { data: row, error: insertError } = await supabase
      .from('aeo_readiness_checks')
      .insert({
        user_id: userId,
        url: normalizedUrl,
        depth: 'homepage',
        score: report.aeo_readiness_score,
        report,
        ip_hash: userId ? null : ipHash,
        source: userId ? 'dashboard' : 'public',
      })
      .select('check_id')
      .single();

    if (insertError || !row) {
      console.error('[aeo-readiness] insert error:', insertError?.message);
      return NextResponse.json({ error: 'Failed to save result' }, { status: 500 });
    }

    return NextResponse.json({
      check_id: row.check_id as string,
      score: report.aeo_readiness_score,
      report,
    });
  } catch (err) {
    console.error('[aeo-readiness] unhandled error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
