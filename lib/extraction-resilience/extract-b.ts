import { stripHtml } from '@/lib/aeo-readiness/content-analyzer';
import type { FlattenedExtraction } from './types';

// EXTRACT_B — Prequire's existing flattened extraction, used deliberately as a
// degraded stress-test path.
//
// This is NOT "what AI sees". It is a lossy baseline. Comparing EXTRACT_A
// against it measures whether meaning survives degradation; a large delta means
// the page is vulnerable to lossy extraction, not that the page is badly
// authored. The flattening itself is `stripHtml` from the AEO readiness
// content analyzer — reused rather than reimplemented so the stress-test path
// stays identical to the one already shipping elsewhere in the scanner.

export function extractB(rawHtml: string): FlattenedExtraction {
  const text = stripHtml(rawHtml ?? '');
  const tokens = text.length > 0 ? text.split(/\s+/).filter(Boolean) : [];
  return { text, tokens, length: text.length };
}
