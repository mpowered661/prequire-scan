import { NextRequest, NextResponse } from 'next/server';
import { captureLead } from '@/lib/supabase/captureLead';
import { isValidEmail } from '@/lib/validation';
import { scoreBand } from '@/lib/scanUtils';

// Optional email-report capture (Lead Capture sprint). The scan result is
// never gated on this endpoint: it exists purely so a visitor who already has
// their result on screen can ask for the report by email. Failure here never
// invalidates the completed scan — the client treats any error as "your
// result is still right there."
//
// This endpoint accepts NO phone number and can trigger NO SMS.
export async function POST(req: NextRequest) {
  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!isValidEmail(body.email)) {
      return NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 });
    }

    if (typeof body.url !== 'string' || !body.url.trim()) {
      return NextResponse.json({ error: 'url is required' }, { status: 400 });
    }
    let normalizedUrl: string;
    try {
      normalizedUrl = new URL(
        body.url.startsWith('http') ? body.url : `https://${body.url}`,
      ).toString();
    } catch {
      return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
    }

    const score =
      typeof body.score === 'number' && Number.isFinite(body.score)
        ? Math.max(0, Math.min(100, Math.round(body.score)))
        : null;
    if (score === null) {
      return NextResponse.json({ error: 'score is required' }, { status: 400 });
    }

    const str = (v: unknown): string | null =>
      typeof v === 'string' && v.length <= 300 ? v : null;

    const outcome = await captureLead({
      email: body.email,
      url: normalizedUrl,
      scan_id: str(body.scan_id),
      score,
      band: scoreBand(score),
      scanned_at: str(body.scanned_at),
      registry_version: str(body.registry_version),
      prompt_version: str(body.prompt_version),
      model: str(body.model),
      utm_source: str(body.utm_source),
      utm_medium: str(body.utm_medium),
      utm_campaign: str(body.utm_campaign),
      utm_content: str(body.utm_content),
      utm_term: str(body.utm_term),
    });

    if (!outcome.ok) {
      // Fail safe: the client shows a gentle retry message; the on-screen scan
      // result is unaffected.
      return NextResponse.json(
        { error: 'Could not save your request. Please try again.' },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, duplicate: outcome.duplicate });
  } catch (err) {
    console.error('[capture-lead] unhandled error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
