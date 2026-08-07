import { NextRequest, NextResponse } from 'next/server';
import { isTrackedEvent, sanitizeProps } from '@/lib/events';

// Funnel event sink: one structured JSON log line per valid event, observable
// in Vercel function logs. Allowlisted names + properties only; no storage,
// no PII. Always answers 204 for valid events so beacons stay cheap.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!isTrackedEvent(body?.event)) {
      return NextResponse.json({ error: 'unknown event' }, { status: 400 });
    }
    console.log(
      '[events]',
      JSON.stringify({
        event: body.event,
        props: sanitizeProps(body.props),
        at: new Date().toISOString(),
      }),
    );
    return new NextResponse(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
}
