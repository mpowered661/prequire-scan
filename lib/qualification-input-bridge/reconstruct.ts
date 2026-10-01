// Safe reconstruction of a persisted QualificationInput.
//
// A database row is NEVER cast. `payload as QualificationInput` would accept
// anything the database happens to hold, including a shape crafted before a
// constraint existed. Every field is checked, and a malformed artifact is
// REFUSED WHOLE — never repaired by dropping the offending part, because
// silently deleting evidence is how an incomplete observation starts looking
// like a complete one.

import type {
  DurableLinkRelationship,
  DurablePageObservation,
  DurableScanUrl,
  DurableTargetObservation,
  QualificationInput,
} from '../opportunity-qualification/types';
import { ACCEPTED_SCAN_MODES, FORBIDDEN_PAYLOAD_KEYS, type ReconstructionCode } from './contract';

export interface ReconstructionFailure {
  code: ReconstructionCode;
  detail: string;
}

export type ReconstructionOutcome =
  | { ok: true; input: QualificationInput }
  | { ok: false; failures: ReconstructionFailure[] };

class Refused extends Error {
  constructor(readonly code: ReconstructionCode, readonly detail: string) {
    super(`${code}: ${detail}`);
  }
}

const refuse = (code: ReconstructionCode, detail: string): never => {
  throw new Refused(code, detail);
};

/**
 * Structural audit of a parsed JSON value.
 *
 * Rejects every non-JSON carrier (function, Map, Set, Date, class instance,
 * undefined) and every forbidden key. `__proto__` is checked with
 * `hasOwnProperty` because an own `__proto__` survives JSON.parse while
 * ordinary property access would read the prototype instead.
 */
function auditJsonShape(value: unknown, path: string): void {
  if (value === null) return;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) refuse('non_finite_number', path);
    return;
  }
  if (t === 'undefined') refuse('non_json_value', `${path} is undefined`);
  if (t === 'function') refuse('non_json_value', `${path} is a function`);
  if (t !== 'object') refuse('non_json_value', `${path} is ${t}`);

  if (Array.isArray(value)) {
    value.forEach((v, i) => auditJsonShape(v, `${path}[${i}]`));
    return;
  }
  if (value instanceof Date) refuse('non_json_value', `${path} is a Date`);
  if (value instanceof Map) refuse('non_json_value', `${path} is a Map`);
  if (value instanceof Set) refuse('non_json_value', `${path} is a Set`);
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    refuse('unexpected_prototype', `${path} is not a plain object`);
  }
  for (const key of FORBIDDEN_PAYLOAD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      refuse('forbidden_key', `${path} carries an own "${key}"`);
    }
  }
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o)) auditJsonShape(o[key], `${path}.${key}`);
}

const obj = (v: unknown, path: string): Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    refuse('payload_not_object', `${path} is not an object`);
  }
  return v as Record<string, unknown>;
};

function str(o: Record<string, unknown>, key: string, path: string): string {
  const v = o[key];
  if (v === undefined) refuse('missing_required_field', `${path}.${key}`);
  if (typeof v !== 'string') refuse('wrong_primitive_type', `${path}.${key} expected string, got ${v === null ? 'null' : typeof v}`);
  return v as string;
}
function nstr(o: Record<string, unknown>, key: string, path: string): string | null {
  const v = o[key];
  if (v === undefined) refuse('missing_required_field', `${path}.${key} (null is required, absent is not null)`);
  if (v !== null && typeof v !== 'string') refuse('wrong_primitive_type', `${path}.${key} expected string|null, got ${typeof v}`);
  return v as string | null;
}
function num(o: Record<string, unknown>, key: string, path: string): number {
  const v = o[key];
  if (v === undefined) refuse('missing_required_field', `${path}.${key}`);
  if (typeof v !== 'number') refuse('wrong_primitive_type', `${path}.${key} expected number, got ${v === null ? 'null' : typeof v}`);
  if (!Number.isFinite(v as number)) refuse('non_finite_number', `${path}.${key}`);
  return v as number;
}
function nnum(o: Record<string, unknown>, key: string, path: string): number | null {
  const v = o[key];
  if (v === undefined) refuse('missing_required_field', `${path}.${key}`);
  if (v !== null && typeof v !== 'number') refuse('wrong_primitive_type', `${path}.${key} expected number|null, got ${typeof v}`);
  if (v !== null && !Number.isFinite(v as number)) refuse('non_finite_number', `${path}.${key}`);
  return v as number | null;
}
function bool(o: Record<string, unknown>, key: string, path: string): boolean {
  const v = o[key];
  if (v === undefined) refuse('missing_required_field', `${path}.${key}`);
  if (typeof v !== 'boolean') refuse('wrong_primitive_type', `${path}.${key} expected boolean, got ${v === null ? 'null' : typeof v}`);
  return v as boolean;
}
function nbool(o: Record<string, unknown>, key: string, path: string): boolean | null {
  const v = o[key];
  if (v === undefined) refuse('missing_required_field', `${path}.${key}`);
  if (v !== null && typeof v !== 'boolean') refuse('wrong_primitive_type', `${path}.${key} expected boolean|null, got ${typeof v}`);
  return v as boolean | null;
}
function arr(o: Record<string, unknown>, key: string, path: string): unknown[] {
  const v = o[key];
  if (v === undefined) refuse('missing_required_field', `${path}.${key} (an absent collection is not an observed empty one)`);
  if (!Array.isArray(v)) refuse('wrong_primitive_type', `${path}.${key} expected array, got ${typeof v}`);
  return v as unknown[];
}
function oneOf<T extends string>(value: string, allowed: readonly string[], path: string): T {
  if (!allowed.includes(value)) refuse('wrong_primitive_type', `${path} is "${value}", not one of ${allowed.join('|')}`);
  return value as T;
}

const FETCH_STATES = ['not_attempted', 'fetched', 'skipped', 'blocked', 'failed', 'redirected_not_followed'];
const ANALYSIS_STATES = ['not_attempted', 'partial', 'complete', 'failed'];
const CHECK_STATES = ['checked', 'unchecked'];
const CLASSIFICATIONS = ['healthy', 'redirected', 'broken_4xx', 'server_failure_5xx', 'blocked', 'timeout', 'undeterminable'];
const PLACEMENTS = ['footer', 'nav', 'body', 'unknown'];
const OBS_STATUS = ['ok', 'failed'];

/**
 * Validates and rebuilds the exact QualificationInput from a parsed payload.
 *
 * `expectedScanId` ties the artifact to the scan row that produced it, so a
 * payload cannot be read under the wrong scan identity.
 */
export function reconstructQualificationInput(
  payload: unknown,
  expectedScanId: string,
): ReconstructionOutcome {
  try {
    auditJsonShape(payload, 'payload');
    const p = obj(payload, 'payload');

    const scanId = str(p, 'scanId', 'payload');
    if (scanId !== expectedScanId) {
      refuse('scan_id_association_mismatch', `payload carries ${scanId}, row is ${expectedScanId}`);
    }
    const scanMode = oneOf<QualificationInput['scanMode']>(
      str(p, 'scanMode', 'payload'), ACCEPTED_SCAN_MODES, 'payload.scanMode');
    const domain = str(p, 'domain', 'payload');

    const c = obj(p.coverage, 'payload.coverage');
    const coverage = {
      discovered: num(c, 'discovered', 'payload.coverage'),
      selected: num(c, 'selected', 'payload.coverage'),
      fetched: num(c, 'fetched', 'payload.coverage'),
      analysisComplete: num(c, 'analysisComplete', 'payload.coverage'),
      uniqueInternalTargets: num(c, 'uniqueInternalTargets', 'payload.coverage'),
      targetsChecked: num(c, 'targetsChecked', 'payload.coverage'),
      targetsUnchecked: num(c, 'targetsUnchecked', 'payload.coverage'),
      siteTotalKnown: bool(c, 'siteTotalKnown', 'payload.coverage'),
    };

    const scanUrls: DurableScanUrl[] = arr(p, 'scanUrls', 'payload').map((raw, i) => {
      const path = `payload.scanUrls[${i}]`;
      const r = obj(raw, path);
      return {
        urlNormalized: nstr(r, 'urlNormalized', path),
        httpStatus: nnum(r, 'httpStatus', path),
        contentSha256: nstr(r, 'contentSha256', path),
        fetchState: oneOf<string>(str(r, 'fetchState', path), FETCH_STATES, `${path}.fetchState`),
        analysisState: oneOf<DurableScanUrl['analysisState']>(
          str(r, 'analysisState', path), ANALYSIS_STATES, `${path}.analysisState`),
        analyzed: bool(r, 'analyzed', path),
      };
    });

    const pageObservations: DurablePageObservation[] = arr(p, 'pageObservations', 'payload').map((raw, i) => {
      const path = `payload.pageObservations[${i}]`;
      const r = obj(raw, path);
      if (!Object.prototype.hasOwnProperty.call(r, 'observation')) {
        refuse('missing_required_field', `${path}.observation`);
      }
      return {
        scanId: str(r, 'scanId', path),
        requestedUrl: str(r, 'requestedUrl', path),
        finalUrl: str(r, 'finalUrl', path),
        engine: str(r, 'engine', path),
        engineVersion: str(r, 'engineVersion', path),
        contentSha256: str(r, 'contentSha256', path),
        status: oneOf<DurablePageObservation['status']>(str(r, 'status', path), OBS_STATUS, `${path}.status`),
        errorReason: nstr(r, 'errorReason', path),
        observedAt: str(r, 'observedAt', path),
        scope: oneOf<'page'>(str(r, 'scope', path), ['page'], `${path}.scope`),
        // Already audited as JSON-shaped; carried through exactly, never rewritten.
        observation: r.observation,
      };
    });

    const linkTargets: DurableTargetObservation[] = arr(p, 'linkTargets', 'payload').map((raw, i) => {
      const path = `payload.linkTargets[${i}]`;
      const r = obj(raw, path);
      const classification = r.classification;
      if (classification === undefined) refuse('missing_required_field', `${path}.classification`);
      if (classification !== null) {
        oneOf<string>(str(r, 'classification', path), CLASSIFICATIONS, `${path}.classification`);
      }
      return {
        targetUrlNormalized: str(r, 'targetUrlNormalized', path),
        checkState: oneOf<DurableTargetObservation['checkState']>(
          str(r, 'checkState', path), CHECK_STATES, `${path}.checkState`),
        uncheckedReason: nstr(r, 'uncheckedReason', path),
        classification: classification as DurableTargetObservation['classification'],
        httpStatus: nnum(r, 'httpStatus', path),
        redirectTargetUrl: nstr(r, 'redirectTargetUrl', path),
        redirectLeftOrigin: nbool(r, 'redirectLeftOrigin', path),
        redirectHops: num(r, 'redirectHops', path),
        methodUsed: nstr(r, 'methodUsed', path),
        sourceLinkCount: num(r, 'sourceLinkCount', path),
        checkedAt: nstr(r, 'checkedAt', path),
      };
    });

    const linkRelationships: DurableLinkRelationship[] = arr(p, 'linkRelationships', 'payload').map((raw, i) => {
      const path = `payload.linkRelationships[${i}]`;
      const r = obj(raw, path);
      return {
        sourceUrl: str(r, 'sourceUrl', path),
        targetUrlNormalized: nstr(r, 'targetUrlNormalized', path),
        anchorText: nstr(r, 'anchorText', path),
        placement: oneOf<DurableLinkRelationship['placement']>(
          str(r, 'placement', path), PLACEMENTS, `${path}.placement`),
        internal: bool(r, 'internal', path),
      };
    });

    return {
      ok: true,
      input: { scanId, scanMode, domain, coverage, scanUrls, pageObservations, linkTargets, linkRelationships },
    };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, failures: [{ code: e.code, detail: e.detail }] };
    throw e;
  }
}
