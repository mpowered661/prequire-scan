// Operator-triggered server-side site scan -> immutable QualificationInput.
//
// TRUST BOUNDARY. The caller supplies ONLY a target seed url. It cannot supply
// evidence, a QualificationInput, a ReviewPacket, a claim, a hash, a coverage
// counter, a qualification outcome, or even a scan_id — the server generates
// the scan identity and observes the evidence itself through the accepted
// site-discovery pipeline.
//
// THIS IS NOT REVIEWER AUTHORIZATION. The internal token below gates an
// expensive internal operation, exactly as it already gates /api/scan for
// Quinn's server-to-server calls. It establishes NO human identity, NO
// presentation.approve capability, and nothing about human review. Phase 2b
// authorization is a separate, unbuilt system.

import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { runScan } from '@/lib/site-discovery/run-scan';
import { buildQualificationInput } from '@/lib/qualification-input-bridge/adapter';
import { persistQualificationInput } from '@/lib/qualification-input-bridge/store';
import { qualificationInputHash } from '@/lib/qualification-input-bridge/canonical-hash';

export const maxDuration = 300;

/**
 * Fail-closed internal gate. An unset env token refuses every request rather
 * than allowing a bypass, so a missing deployment variable cannot silently open
 * an expensive public scanning endpoint.
 */
function isInternalOperator(req: NextRequest): boolean {
  const expected = process.env.SCAN_INTERNAL_TOKEN;
  if (!expected) return false;
  const supplied = req.headers.get('x-internal-token');
  return !!supplied && supplied === expected;
}

export async function POST(req: NextRequest) {
  if (!isInternalOperator(req)) {
    return NextResponse.json({ error: 'Not authorized for internal scan.' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const supplied = (body ?? {}) as Record<string, unknown>;

  // Only a target is accepted. Anything evidence-shaped is refused outright
  // rather than ignored, so a caller cannot believe it influenced the evidence.
  const FORBIDDEN_INPUTS = [
    'qualificationInput', 'reviewPacket', 'packet', 'evidence', 'scanUrls',
    'pageObservations', 'linkTargets', 'linkRelationships', 'coverage',
    'claimHash', 'reviewPacketHash', 'evidenceFingerprint', 'qualification', 'scanId', 'scan_id',
  ];
  const offered = FORBIDDEN_INPUTS.filter(k => Object.prototype.hasOwnProperty.call(supplied, k));
  if (offered.length > 0) {
    return NextResponse.json(
      { error: 'This endpoint accepts a target only; evidence and identity are produced server-side.', rejectedFields: offered },
      { status: 400 },
    );
  }

  const target = supplied.url;
  if (typeof target !== 'string' || target.length === 0) {
    return NextResponse.json({ error: 'url is required' }, { status: 400 });
  }
  let seedUrl: string;
  try {
    const parsed = new URL(target.startsWith('http') ? target : `https://${target}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('scheme');
    seedUrl = parsed.toString();
  } catch {
    return NextResponse.json({ error: 'Invalid target url' }, { status: 400 });
  }

  // One invocation is one immutable observation event.
  const scanId = randomUUID();

  const result = await runScan({ seedUrl, scanId });

  const built = buildQualificationInput(scanId, result);
  if (!built.ok) {
    // An incomplete observation is reported, never padded into a complete one.
    return NextResponse.json(
      {
        scan_id: scanId,
        status: result.manifest.status,
        persisted: false,
        incomplete: built.refusals.map(r => ({ code: r.code, detail: r.detail })),
      },
      { status: 422 },
    );
  }

  const persisted = await persistQualificationInput(built.input);
  if (!persisted.ok) {
    return NextResponse.json(
      { scan_id: scanId, status: result.manifest.status, persisted: false, error: persisted.code, detail: persisted.detail },
      { status: persisted.code === 'conflicting_payload_for_scan' ? 409 : 500 },
    );
  }

  // Bounded metadata only — no evidence, no payload, no credentials.
  return NextResponse.json({
    scan_id: scanId,
    domain: built.input.domain,
    status: result.manifest.status,
    persisted: true,
    created: persisted.created,
    input_hash: qualificationInputHash(built.input),
    coverage: built.input.coverage,
  });
}
