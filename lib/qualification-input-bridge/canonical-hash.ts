// Deterministic content identity for a QualificationInput.
//
// STRUCTURAL CANONICALIZATION, NOT DELIMITER CONCATENATION. Every value is
// emitted as its own JSON token with an explicit key, so a value containing a
// quote, comma, bracket or control character cannot imitate a field boundary.
// This is the same lesson the hra-0.1.1 repair recorded: delimiter-joined
// encodings collide, structural ones do not.
//
// WHAT THIS HASH IS, AND IS NOT.
//
// `input_hash` is an INTEGRITY IDENTITY over the exact persisted
// QualificationInput REPRESENTATION. It answers one question:
//
//     "Is this the exact immutable QualificationInput we persisted?"
//
// It does NOT answer:
//
//     "Would these two inputs qualify identically?"
//
// It is therefore not a semantic qualification identity, not a ReviewPacket
// identity, not a claim identity, and not a replacement for
// evidence_fingerprint. Those identities are produced by the accepted
// qualification, opportunity-review and human-review layers.
//
// It binds: every field value, collection membership, collection ordering AS
// PERSISTED, coverage, scan identity, and the hash-contract version.
//
// CONSEQUENCE, intended and accepted:
//   same persisted representation            -> same input_hash
//   same semantic evidence, reordered        -> MAY produce a different input_hash
//
// CORRECTION (follow-up to the v0.1 acceptance inspection): an earlier version
// of this comment justified order-sensitivity by claiming "the qualification
// contract treats them as sequences, not sets". THAT WAS FALSE. The accepted
// qualification layer is ORDER-INSENSITIVE for its semantic result and asserts
// so in its own tests — reversing all four collections yields an identical
// qualification result and an identical ReviewPacket set, and duplicate
// evidence does not inflate counts. Order-sensitivity here is a property of
// the INTEGRITY hash, not a property of the qualification contract.
//
// ORDERING RULES (explicit, because getting these wrong silently changes identity):
//   - Object keys are emitted in a FIXED order written in this file, never from
//     Object.keys of the incoming object, so property insertion order cannot
//     affect the hash.
//   - All four evidence collections are hashed in the order persisted. They are
//     NOT sorted and NOT deduplicated: normalizing them would make the hash
//     stop identifying the stored representation, which is its only job.
//   - null is preserved and is distinct from an absent key and from "".
//   - An absent collection never reaches this function: the adapter refuses it.

import { createHash } from 'node:crypto';
import type {
  CoverageContext,
  DurableLinkRelationship,
  DurablePageObservation,
  DurableScanUrl,
  DurableTargetObservation,
  QualificationInput,
} from '../opportunity-qualification/types';
import { QUALIFICATION_INPUT_HASH_VERSION } from './contract';

/**
 * Canonical JSON for an arbitrary evidence value (the `observation` payload of
 * a page observation is `unknown` by contract).
 *
 * Keys are sorted so two semantically identical observations canonicalize
 * identically regardless of how the engine built the object. Anything that is
 * not JSON-shaped throws rather than being coerced.
 */
function canonicalValue(value: unknown, path: string): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error(`non-finite number at ${path}; refusing to hash`);
    }
    return JSON.stringify(value);
  }
  if (t !== 'object') {
    throw new Error(`non-JSON value of type ${t} at ${path}; refusing to hash`);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v, i) => canonicalValue(v, `${path}[${i}]`)).join(',') + ']';
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`non-plain object at ${path}; refusing to hash`);
  }
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return '{' + keys.map(k => `${JSON.stringify(k)}:${canonicalValue(o[k], `${path}.${k}`)}`).join(',') + '}';
}

const coverageJson = (c: CoverageContext): string => JSON.stringify({
  analysisComplete: c.analysisComplete,
  discovered: c.discovered,
  fetched: c.fetched,
  selected: c.selected,
  siteTotalKnown: c.siteTotalKnown,
  targetsChecked: c.targetsChecked,
  targetsUnchecked: c.targetsUnchecked,
  uniqueInternalTargets: c.uniqueInternalTargets,
});

const scanUrlJson = (u: DurableScanUrl): string => JSON.stringify({
  analysisState: u.analysisState, analyzed: u.analyzed, contentSha256: u.contentSha256,
  fetchState: u.fetchState, httpStatus: u.httpStatus, urlNormalized: u.urlNormalized,
});

const targetJson = (t: DurableTargetObservation): string => JSON.stringify({
  checkState: t.checkState, checkedAt: t.checkedAt, classification: t.classification,
  httpStatus: t.httpStatus, methodUsed: t.methodUsed, redirectHops: t.redirectHops,
  redirectLeftOrigin: t.redirectLeftOrigin, redirectTargetUrl: t.redirectTargetUrl,
  sourceLinkCount: t.sourceLinkCount, targetUrlNormalized: t.targetUrlNormalized,
  uncheckedReason: t.uncheckedReason,
});

const relationshipJson = (l: DurableLinkRelationship): string => JSON.stringify({
  anchorText: l.anchorText, internal: l.internal, placement: l.placement,
  sourceUrl: l.sourceUrl, targetUrlNormalized: l.targetUrlNormalized,
});

function observationJson(o: DurablePageObservation, i: number): string {
  // `observation` is `unknown` by contract, so it goes through the recursive
  // canonicalizer; every other field is a declared scalar.
  return '{'
    + `"contentSha256":${JSON.stringify(o.contentSha256)},`
    + `"engine":${JSON.stringify(o.engine)},`
    + `"engineVersion":${JSON.stringify(o.engineVersion)},`
    + `"errorReason":${JSON.stringify(o.errorReason ?? null)},`
    + `"finalUrl":${JSON.stringify(o.finalUrl)},`
    + `"observation":${canonicalValue(o.observation, `pageObservations[${i}].observation`)},`
    + `"observedAt":${JSON.stringify(o.observedAt)},`
    + `"requestedUrl":${JSON.stringify(o.requestedUrl)},`
    + `"scanId":${JSON.stringify(o.scanId)},`
    + `"scope":${JSON.stringify(o.scope)},`
    + `"status":${JSON.stringify(o.status)}`
    + '}';
}

/** The full canonical form. Every field of QualificationInput participates. */
export function canonicalQualificationInputJson(input: QualificationInput): string {
  return '{'
    + `"hashVersion":${JSON.stringify(QUALIFICATION_INPUT_HASH_VERSION)},`
    + `"scanId":${JSON.stringify(input.scanId)},`
    + `"scanMode":${JSON.stringify(input.scanMode)},`
    + `"domain":${JSON.stringify(input.domain)},`
    + `"coverage":${coverageJson(input.coverage)},`
    + `"scanUrls":[${input.scanUrls.map(scanUrlJson).join(',')}],`
    + `"pageObservations":[${input.pageObservations.map(observationJson).join(',')}],`
    + `"linkTargets":[${input.linkTargets.map(targetJson).join(',')}],`
    + `"linkRelationships":[${input.linkRelationships.map(relationshipJson).join(',')}]`
    + '}';
}

/** Full-width sha256 — this is an integrity identity, not a display id. */
export function qualificationInputHash(input: QualificationInput): string {
  return createHash('sha256').update(canonicalQualificationInputJson(input)).digest('hex');
}
