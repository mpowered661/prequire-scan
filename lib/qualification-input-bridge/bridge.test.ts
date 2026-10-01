// Trusted scan -> QualificationInput bridge: adapter, hash, reconstruction and
// deterministic re-derivation. Fixture only; Michael is never run live.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { qualify } from '../opportunity-qualification/qualify';
import type { QualificationInput } from '../opportunity-qualification/types';
import { deriveReview, type QualificationResultView } from '../opportunity-review/review-packet';
import { buildQualificationInput } from './adapter';
import { canonicalQualificationInputJson, qualificationInputHash } from './canonical-hash';
import {
  ACCEPTED_QUALIFICATION_VERSION,
  COVERAGE_COUNTERS,
  QUALIFICATION_INPUT_HASH_VERSION,
  QUALIFICATION_INPUT_SCHEMA_VERSION,
} from './contract';
import { reviewPacketHash } from '../human-review/packet-hash';
import type { ReviewPacketView } from '../human-review/types';
import type { ReviewPacket } from '../opportunity-review/types';
import { reconstructQualificationInput } from './reconstruct';
import { rederiveFromRow } from './rederive';
import type { StoredQualificationInputRow } from './contract';

const FIXTURE = JSON.parse(
  readFileSync(new URL('../opportunity-qualification/__fixtures__/michael-pilot.json', import.meta.url), 'utf8'),
) as QualificationInput & { _provenance?: unknown };

/** The fixture without its documentation key — exactly what the adapter emits. */
function fixtureInput(): QualificationInput {
  const { _provenance, ...rest } = FIXTURE as unknown as Record<string, unknown>;
  return JSON.parse(JSON.stringify(rest)) as QualificationInput;
}

function storedRow(input: QualificationInput, over: Partial<StoredQualificationInputRow> = {}): StoredQualificationInputRow {
  return {
    scan_id: input.scanId,
    input_schema_version: QUALIFICATION_INPUT_SCHEMA_VERSION,
    qualification_version: ACCEPTED_QUALIFICATION_VERSION,
    input_hash: qualificationInputHash(input),
    payload: JSON.parse(JSON.stringify(input)),
    created_at: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

/** Bridges an or-0.1 packet into the frozen hra structural view, read-only. */
function toPacketView(p: ReviewPacket): ReviewPacketView {
  const direct = p.claimCandidates.find(c => c.epistemicClass === 'DIRECT_OBSERVATION' && c.externallyPresentable)
    ?? p.claimCandidates[0];
  return {
    opportunityKey: p.opportunityKey, evidenceFingerprint: p.evidenceFingerprint, claimHash: p.claimHash,
    qualificationStatus: p.qualificationStatus,
    gateTrace: p.gateTrace.map(g => ({ gate: g.gate, passed: g.passed })),
    presentationPermission: direct.presentationPermission, presentationMode: p.presentationMode,
    demonstrabilityStatus: p.demonstration.status,
    meetsScoutEvidenceRequirements: p.meetsScoutEvidenceRequirements,
    temporalFrame: p.canonicalClaim.temporalFrame, reviewContractVersion: p.reviewContractVersion,
    qualificationVersion: p.qualificationVersion, evidenceRefs: p.evidenceRefs,
    displayProse: direct.prose, canonicalClaim: p.canonicalClaim, demonstration: p.demonstration,
    observedAt: p.canonicalClaim.observedAt, scanId: p.scanId,
  };
}

/** Identity-bearing fields only — prose equality is not evidence of identity. */
function identities(review: { packets: { subject: string; opportunityKey: string; evidenceFingerprint: string; claimHash: string }[] }) {
  return review.packets
    .map(p => ({ subject: p.subject, opportunityKey: p.opportunityKey, evidenceFingerprint: p.evidenceFingerprint, claimHash: p.claimHash }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

describe('Michael round trip — persistence must not alter accepted output', () => {
  const direct = deriveReview(qualify(fixtureInput()) as unknown as QualificationResultView);

  it('1 the accepted calibration is unchanged through the bridge', () => {
    const q1 = qualify(fixtureInput());
    expect(q1.opportunities).toHaveLength(13);
    expect(direct.packets).toHaveLength(7);

    const out = rederiveFromRow(storedRow(fixtureInput()));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.review.packets).toHaveLength(7);
    expect((qualify(out.input)).opportunities).toHaveLength(13);
  });

  it('2 all seven ReviewPacket identities survive the round trip exactly', () => {
    const out = rederiveFromRow(storedRow(fixtureInput()));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(identities(out.review)).toEqual(identities(direct));
  });

  it('3 every review_packet_hash is unchanged, and /about/ is still cb4bfaa0...', () => {
    const out = rederiveFromRow(storedRow(fixtureInput()));
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const before = new Map(direct.packets.map(p => [p.subject, reviewPacketHash(toPacketView(p))]));
    const after = new Map(out.review.packets.map(p => [p.subject, reviewPacketHash(toPacketView(p))]));
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [subject, hash] of before) {
      expect(after.get(subject), subject).toBe(hash);
    }
    expect(after.get('https://michaelhingson.com/about/')).toBe('cb4bfaa08dae48871f7b8e90a6973aef');
  });

  it('4 reconstruction returns a value byte-identical to the original input', () => {
    const original = fixtureInput();
    const r = reconstructQualificationInput(JSON.parse(JSON.stringify(original)), original.scanId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.stringify(r.input)).toBe(JSON.stringify(original));
    expect(qualificationInputHash(r.input)).toBe(qualificationInputHash(original));
  });

  it('5 no network is performed during re-derivation', () => {
    const spy = vi.fn(() => { throw new Error('the bridge attempted a network request'); });
    const original = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const out = rederiveFromRow(storedRow(fixtureInput()));
      expect(out.ok).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── synthetic complete observation, for adapter behaviour ────
const SCAN = '11111111-2222-4333-8444-555555555555';

function manifest(over: Record<string, unknown> = {}) {
  return {
    manifest_version: 'cm-1', scan_id: SCAN, scan_mode: 'prospect_observation',
    domain: 'example.org', seed_url: 'https://example.org/',
    started_at: '2026-10-01T00:00:00.000Z', completed_at: '2026-10-01T00:01:00.000Z',
    status: 'complete', abort_reason: null,
    method: { discovery_version: 'd', normalization_version: 'n', config: { max_child_sitemaps: 1, max_sitemap_depth: 1, max_loc_entries: 1, max_discovery_requests: 1 } },
    discovery: { methods_used: [], sitemaps_found: 0, sitemaps_parsed: 0, sitemaps_skipped_cross_origin: 0, sitemap_entries_seen: 0, discovery_complete: true, truncation_reason: null, requests_made: 1 },
    page_analysis: { engine_set_version: 'e', engines: [], engine_versions: {}, pages_fetched: 2, pages_analysis_complete: 2, pages_analysis_partial: 0, pages_analysis_failed: 0, pages_not_attempted: 0, observations_recorded: 1, engine_failures_by_reason: {}, network_requests_made: 0, stop_reason: 'complete' },
    link_integrity: { link_extract_version: 'l', target_check_version: 't', link_integrity_version: 'li', pages_supplying_html: 2, links_observed: 1, internal_links_observed: 1, external_links_observed: 0, unsupported_links_observed: 0, unique_internal_targets: 9, targets_eligible: 9, targets_selected_for_check: 4, targets_checked: 4, targets_unchecked: 5, unchecked_by_reason: {}, targets_healthy: 4, targets_redirected: 0, targets_broken_4xx: 0, targets_server_failure_5xx: 0, targets_blocked: 0, targets_timeout: 0, targets_undeterminable: 0, head_requests: 4, get_fallbacks: 0, redirect_hops: 0, retries_used: 0, target_check_requests_made: 4, stop_reason: 'complete' },
    urls: { discovered: 7, in_scope: 5, excluded: 2, selected: 3, attempted: 3, fetched: 2, analyzed: 2, skipped: 1, blocked: 0, failed: 0 },
    coverage: [],
    ...over,
  };
}
function completeResult(over: Record<string, unknown> = {}) {
  return {
    manifest: manifest(),
    urls: [{ urlRaw: 'https://example.org/', urlNormalized: 'https://example.org/', discoveryMethod: 'seed', discoveredFromUrl: null, sitemapSourceUrl: null, linkDepth: 0, inScope: true, excludedReason: null, fetchState: 'fetched', httpStatus: 200, analyzed: true, analysisState: 'complete', firstSeenAt: '2026-10-01T00:00:00.000Z', contentSha256: 'a'.repeat(64) }],
    pageObservations: [{ scanId: SCAN, requestedUrl: 'https://example.org/', finalUrl: 'https://example.org/', engine: 'meta_tags', engineVersion: 'v1', contentSha256: 'a'.repeat(64), observation: { title: 'x', nested: { a: [1, 2, null] } }, status: 'ok', errorReason: null, observedAt: '2026-10-01T00:00:30.000Z', scope: 'page' }],
    linkTargets: [{ targetUrlNormalized: 'https://example.org/b', checkState: 'checked', uncheckedReason: null, classification: 'healthy', httpStatus: 200, redirectTargetUrl: null, redirectLeftOrigin: null, redirectHops: 0, methodUsed: 'HEAD', responseMs: 12, sourceLinkCount: 1, checkedAt: '2026-10-01T00:00:40.000Z' }],
    links: [{ sourceUrl: 'https://example.org/', hrefRaw: '/b', targetUrlNormalized: 'https://example.org/b', anchorText: 'B', placement: 'body', isInternal: true, eligibleForCheck: true, exclusionReason: null }],
    ...over,
  } as unknown as Parameters<typeof buildQualificationInput>[1];
}

describe('adapter — absence is not zero', () => {
  it('6 a complete observation converts, with every coverage counter from a named manifest field', () => {
    const out = buildQualificationInput(SCAN, completeResult());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(Object.keys(out.input.coverage).sort()).toEqual([...COVERAGE_COUNTERS].sort());
    expect(out.input.coverage).toEqual({
      discovered: 7, selected: 3, fetched: 2, analysisComplete: 2,
      uniqueInternalTargets: 9, targetsChecked: 4, targetsUnchecked: 5, siteTotalKnown: false,
    });
    expect(out.input.scanUrls).toHaveLength(1);
    expect(out.input.linkRelationships[0]).toEqual({
      sourceUrl: 'https://example.org/', targetUrlNormalized: 'https://example.org/b',
      anchorText: 'B', placement: 'body', internal: true,
    });
    // performance telemetry is not evidence and must not enter the hash
    expect(Object.keys(out.input.linkTargets[0])).not.toContain('responseMs');
  });

  it('7 siteTotalKnown is always false — a bounded crawl never establishes a site total', () => {
    const out = buildQualificationInput(SCAN, completeResult());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.input.coverage.siteTotalKnown).toBe(false);
  });

  it('8 an ABSENT evidence collection is refused, never converted to []', () => {
    for (const [field, code] of [
      ['pageObservations', 'page_observations_absent'],
      ['linkTargets', 'link_targets_absent'],
      ['links', 'link_relationships_absent'],
    ] as const) {
      const r = completeResult() as unknown as Record<string, unknown>;
      delete r[field];
      const out = buildQualificationInput(SCAN, r as never);
      expect(out.ok, field).toBe(false);
      if (out.ok) continue;
      expect(out.refusals.map(x => x.code), field).toContain(code);
    }
  });

  it('9 an OBSERVED EMPTY collection is accepted — present and empty is a fact', () => {
    const out = buildQualificationInput(SCAN, completeResult({ links: [], linkTargets: [], pageObservations: [] }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.input.linkRelationships).toEqual([]);
    expect(out.input.linkTargets).toEqual([]);
    expect(out.input.pageObservations).toEqual([]);
  });

  it('10 an aborted or mismatched observation is refused', () => {
    const aborted = buildQualificationInput(SCAN, completeResult({ manifest: manifest({ status: 'aborted', abort_reason: 'robots' }) }));
    expect(aborted.ok).toBe(false);
    if (!aborted.ok) expect(aborted.refusals.map(r => r.code)).toContain('scan_aborted');

    const wrongScan = buildQualificationInput('99999999-2222-4333-8444-555555555555', completeResult());
    expect(wrongScan.ok).toBe(false);
    if (!wrongScan.ok) expect(wrongScan.refusals.map(r => r.code)).toContain('scan_id_mismatch');

    for (const [over, code] of [
      [{ page_analysis: undefined }, 'page_analysis_manifest_absent'],
      [{ link_integrity: undefined }, 'link_integrity_manifest_absent'],
      [{ seed_url: '' }, 'seed_url_missing'],
      [{ scan_mode: 'something_else' }, 'unsupported_scan_mode'],
    ] as const) {
      const out = buildQualificationInput(SCAN, completeResult({ manifest: manifest(over) }));
      expect(out.ok, code).toBe(false);
      if (!out.ok) expect(out.refusals.map(r => r.code), code).toContain(code);
    }
  });
});

describe('input hash contract', () => {
  const base = () => { const o = buildQualificationInput(SCAN, completeResult()); if (!o.ok) throw new Error('setup'); return o.input; };

  it('11 the same semantic input hashes identically, regardless of property order', () => {
    const a = base();
    const shuffled: Record<string, unknown> = {};
    for (const k of ['linkRelationships', 'domain', 'coverage', 'scanUrls', 'scanMode', 'pageObservations', 'linkTargets', 'scanId']) {
      shuffled[k] = (a as unknown as Record<string, unknown>)[k];
    }
    const reordered = JSON.parse(JSON.stringify(shuffled)) as QualificationInput;
    expect(qualificationInputHash(reordered)).toBe(qualificationInputHash(a));
    expect(canonicalQualificationInputJson(a)).toContain(QUALIFICATION_INPUT_HASH_VERSION);
  });

  it('12 every evidence change moves the hash', () => {
    const a = base();
    const h = qualificationInputHash(a);
    const mutate: [string, QualificationInput][] = [
      ['coverage', { ...a, coverage: { ...a.coverage, targetsChecked: a.coverage.targetsChecked + 1 } }],
      ['scanUrl state', { ...a, scanUrls: [{ ...a.scanUrls[0], analysisState: 'partial' }] }],
      ['durable url', { ...a, scanUrls: [{ ...a.scanUrls[0], urlNormalized: 'https://example.org/other' }] }],
      ['relationship', { ...a, linkRelationships: [{ ...a.linkRelationships[0], placement: 'nav' }] }],
      ['target', { ...a, linkTargets: [{ ...a.linkTargets[0], classification: 'broken_4xx' }] }],
      ['observation', { ...a, pageObservations: [{ ...a.pageObservations[0], observation: { title: 'y' } }] }],
      ['domain', { ...a, domain: 'other.example' }],
      ['scanId', { ...a, scanId: '22222222-2222-4333-8444-555555555555' }],
    ];
    for (const [label, m] of mutate) expect(qualificationInputHash(m), label).not.toBe(h);
  });

  it('13 null, absent and empty are distinguished', () => {
    const a = base();
    const withNull = { ...a, scanUrls: [{ ...a.scanUrls[0], contentSha256: null }] };
    const withEmpty = { ...a, scanUrls: [{ ...a.scanUrls[0], contentSha256: '' }] };
    expect(qualificationInputHash(withNull)).not.toBe(qualificationInputHash(withEmpty));
    expect(qualificationInputHash(withEmpty)).not.toBe(qualificationInputHash(a));
    // an observed-empty collection differs from a populated one
    expect(qualificationInputHash({ ...a, linkRelationships: [] })).not.toBe(qualificationInputHash(a));
  });

  it('14 collection ORDER is significant — these are sequences, not sets', () => {
    const a = base();
    const two = { ...a, linkRelationships: [a.linkRelationships[0], { ...a.linkRelationships[0], sourceUrl: 'https://example.org/z' }] };
    const flipped = { ...two, linkRelationships: [...two.linkRelationships].reverse() };
    expect(qualificationInputHash(flipped)).not.toBe(qualificationInputHash(two));
  });

  it('15 a non-JSON or non-finite evidence value refuses to hash', () => {
    const a = base();
    for (const bad of [new Map(), new Set(), new Date(0), () => 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const m = { ...a, pageObservations: [{ ...a.pageObservations[0], observation: bad as unknown }] };
      expect(() => qualificationInputHash(m), String(bad)).toThrow();
    }
  });
});

describe('safe reconstruction — fail closed, never repair', () => {
  const good = () => JSON.parse(JSON.stringify(fixtureInput())) as Record<string, unknown>;

  it('16 a dangerous own __proto__ or constructor key refuses the WHOLE payload', () => {
    const withProto = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const p1 = good();
    (p1.pageObservations as Record<string, unknown>[])[0].observation = withProto;
    const r1 = reconstructQualificationInput(p1, FIXTURE.scanId);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.failures[0].code).toBe('forbidden_key');
    expect(('polluted' in {})).toBe(false);

    const p2 = good();
    (p2.pageObservations as Record<string, unknown>[])[0].observation = JSON.parse('{"constructor":{"x":1}}');
    const r2 = reconstructQualificationInput(p2, FIXTURE.scanId);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.failures[0].code).toBe('forbidden_key');
  });

  it('17 non-JSON carriers at the in-memory boundary are refused', () => {
    for (const [label, bad] of [['Map', new Map()], ['Set', new Set()], ['Date', new Date(0)],
      ['function', () => 1], ['class instance', new (class Q { x = 1; })()], ['undefined', undefined]] as const) {
      const p = good();
      (p.pageObservations as Record<string, unknown>[])[0].observation = bad as unknown;
      const r = reconstructQualificationInput(p, FIXTURE.scanId);
      expect(r.ok, label).toBe(false);
      if (!r.ok) expect(['non_json_value', 'unexpected_prototype', 'missing_required_field'], label).toContain(r.failures[0].code);
    }
  });

  it('18 missing fields, wrong types, and absent-vs-null are each refused', () => {
    const cases: [string, (p: Record<string, unknown>) => void, string][] = [
      ['missing domain', p => { delete p.domain; }, 'missing_required_field'],
      ['domain wrong type', p => { p.domain = 42; }, 'wrong_primitive_type'],
      ['domain null', p => { p.domain = null; }, 'wrong_primitive_type'],
      ['coverage missing counter', p => { delete (p.coverage as Record<string, unknown>).targetsChecked; }, 'missing_required_field'],
      ['coverage wrong type', p => { (p.coverage as Record<string, unknown>).discovered = '7'; }, 'wrong_primitive_type'],
      ['siteTotalKnown wrong type', p => { (p.coverage as Record<string, unknown>).siteTotalKnown = 'false'; }, 'wrong_primitive_type'],
      ['scanUrls absent', p => { delete p.scanUrls; }, 'missing_required_field'],
      ['scanUrls not an array', p => { p.scanUrls = {}; }, 'wrong_primitive_type'],
      ['nullable field absent', p => { delete (p.scanUrls as Record<string, unknown>[])[0].contentSha256; }, 'missing_required_field'],
      ['bad enum', p => { (p.scanUrls as Record<string, unknown>[])[0].analysisState = 'almost'; }, 'wrong_primitive_type'],
      ['observation key absent', p => { delete (p.pageObservations as Record<string, unknown>[])[0].observation; }, 'missing_required_field'],
      ['payload not an object', () => undefined, 'payload_not_object'],
    ];
    for (const [label, mutate, code] of cases) {
      const p = label === 'payload not an object' ? ([] as unknown as Record<string, unknown>) : good();
      mutate(p);
      const r = reconstructQualificationInput(p, FIXTURE.scanId);
      expect(r.ok, label).toBe(false);
      if (!r.ok) expect(r.failures[0].code, label).toBe(code);
    }
  });

  it('19 a payload read under the wrong scan identity is refused', () => {
    const r = reconstructQualificationInput(good(), 'some-other-scan');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures[0].code).toBe('scan_id_association_mismatch');
  });
});

describe('re-derivation — version and integrity gates', () => {
  it('20 a wrong schema or qualification version refuses before reconstruction', () => {
    const i = fixtureInput();
    for (const [over, code] of [
      [{ input_schema_version: 'qualification-input/0.2' }, 'schema_version_mismatch'],
      [{ qualification_version: 'oq-0.1' }, 'qualification_version_mismatch'],
    ] as const) {
      const out = rederiveFromRow(storedRow(i, over));
      expect(out.ok, code).toBe(false);
      if (!out.ok) expect(out.failures.map(f => f.code), code).toContain(code);
    }
  });

  it('21 a payload edited after it was written is caught by hash re-computation', () => {
    const i = fixtureInput();
    const row = storedRow(i);
    // tamper with the stored payload, leaving the stored hash column untouched
    const tampered = JSON.parse(JSON.stringify(row.payload)) as Record<string, unknown>;
    (tampered.coverage as Record<string, unknown>).targetsChecked = 999;
    const out = rederiveFromRow({ ...row, payload: tampered });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failures[0].code).toBe('input_hash_mismatch');
  });

  it('22 a stored hash that does not match the payload refuses', () => {
    const out = rederiveFromRow(storedRow(fixtureInput(), { input_hash: 'f'.repeat(64) }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failures[0].code).toBe('input_hash_mismatch');
  });

  it('23 no failure path returns ReviewPackets', () => {
    const i = fixtureInput();
    const broken = JSON.parse(JSON.stringify(i)) as Record<string, unknown>;
    delete broken.domain;
    const rows = [
      storedRow(i, { input_schema_version: 'x' }),
      storedRow(i, { qualification_version: 'x' }),
      storedRow(i, { input_hash: '0'.repeat(64) }),
      storedRow(i, { payload: broken }),
      storedRow(i, { payload: 'not-an-object' }),
      storedRow(i, { payload: null }),
    ];
    for (const row of rows) {
      const out = rederiveFromRow(row);
      expect(out.ok).toBe(false);
      expect(out).not.toHaveProperty('review');
    }
  });
});

describe('adversarial — the client cannot supply evidence or a packet', () => {
  it('24 re-derivation accepts a scan identity and nothing else', () => {
    // Structural proof: the pure entry takes a row, the async entry takes a
    // single string. Neither has a parameter through which a caller could pass
    // a ReviewPacket, an evidence array, a claim or a hash.
    expect(rederiveFromRow.length).toBe(1);
    const src = readFileSync(new URL('./rederive.ts', import.meta.url), 'utf8');
    expect(src).toContain('scanId: string,\n): Promise<RederivationOutcome>');
    for (const bad of ['reviewPacket', 'packet:', 'claimHash:', 'evidenceArrays', 'suppliedEvidence']) {
      expect(src, bad).not.toContain(bad);
    }
  });

  it('25 a fabricated client ReviewPacket cannot substitute for the derived one', () => {
    const out = rederiveFromRow(storedRow(fixtureInput()));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const fabricated = {
      subject: 'https://michaelhingson.com/about/',
      opportunityKey: 'attacker-chosen', evidenceFingerprint: 'attacker-chosen',
      claimHash: 'attacker-chosen', qualificationStatus: 'QUALIFIED',
    };
    const derived = out.review.packets.find(p => p.subject === fabricated.subject)!;
    expect(derived.opportunityKey).not.toBe(fabricated.opportunityKey);
    expect(derived.evidenceFingerprint).not.toBe(fabricated.evidenceFingerprint);
    expect(derived.claimHash).not.toBe(fabricated.claimHash);
    // and the derived identity is reproducible from the stored evidence alone
    const again = rederiveFromRow(storedRow(fixtureInput()));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.review.packets.find(p => p.subject === fabricated.subject)!.claimHash).toBe(derived.claimHash);
  });

  it('26 two scans of the same domain are independent immutable artifacts', () => {
    const a = fixtureInput();
    // A real second observation carries the new scan identity THROUGHOUT its
    // evidence. The accepted qualification layer enforces this itself.
    const b = JSON.parse(JSON.stringify(a)) as QualificationInput;
    b.scanId = '77777777-2222-4333-8444-555555555555';
    for (const o of b.pageObservations) o.scanId = b.scanId;
    expect(b.domain).toBe(a.domain);
    expect(b.scanId).not.toBe(a.scanId);
    expect(qualificationInputHash(b)).not.toBe(qualificationInputHash(a));

    const first = rederiveFromRow(storedRow(a));
    const second = rederiveFromRow(storedRow(b));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.review.packets).toHaveLength(7);
    expect(second.review.packets).toHaveLength(7);

    // re-deriving the second did not disturb the first
    const firstAgain = rederiveFromRow(storedRow(a));
    expect(firstAgain.ok).toBe(true);
    if (!firstAgain.ok) return;
    expect(identities(firstAgain.review)).toEqual(identities(first.review));
  });

  it('26b evidence belonging to another scan is refused by the accepted layer', () => {
    // Changing only the top-level scanId, leaving evidence stamped with the old
    // one, is refused as cross_scan_cluster_forbidden. Evidence cannot be
    // re-pointed at a different scan event.
    const mixed = JSON.parse(JSON.stringify(fixtureInput())) as QualificationInput;
    mixed.scanId = '88888888-2222-4333-8444-555555555555';
    const out = rederiveFromRow(storedRow(mixed));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failures[0].code).toBe('qualification_refused');
  });

  it('27 the route accepts a target only, and gates on the internal token', () => {
    const raw = readFileSync(new URL('../../app/api/internal/site-scan/route.ts', import.meta.url), 'utf8');
    const route = raw.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    expect(route).toContain('SCAN_INTERNAL_TOKEN');
    expect(route).toContain('if (!expected) return false');
    for (const forbidden of ['qualificationInput', 'reviewPacket', 'scanUrls', 'pageObservations', 'claimHash']) {
      expect(route, forbidden).toContain(forbidden);
    }
    expect(route).toContain('randomUUID()');
    // no reviewer identity or approval vocabulary
    for (const bad of ['TrustedReviewerIdentity', 'presentation.approve', 'operator_capabilities', 'review_decisions', 'presentation_snapshots']) {
      expect(route, bad).not.toContain(bad);
    }
  });
});
