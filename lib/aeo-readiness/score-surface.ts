import type { ReportSummary } from './types';

// Gate 1 score surface: the headline score never renders without its basis.
// A single threshold encodes exactly one rule — a score may not headline when
// most of its input signals are unknown.
export const LOW_COVERAGE_THRESHOLD = 0.5;

export type ScoreSurface =
  | { state: 'legacy' }
  | { state: 'clean'; total: number }
  | { state: 'reduced'; determinable: number; undeterminable: number; total: number }
  | { state: 'low_coverage'; determinable: number; undeterminable: number; total: number };

// 'legacy': the report was stored before the undeterminable concept existed.
// It must render its score with NO basis line — asserting "all N determinable"
// about a scan that never measured coverage would be a false claim.
export function scoreSurface(summary: ReportSummary): ScoreSurface {
  const u = summary.undeterminable;
  if (typeof u !== 'number') return { state: 'legacy' };
  const total = summary.total_crawlers_tested;
  if (u === 0) return { state: 'clean', total };
  const determinable = total - u;
  if (total > 0 && determinable / total >= LOW_COVERAGE_THRESHOLD) {
    return { state: 'reduced', determinable, undeterminable: u, total };
  }
  return { state: 'low_coverage', determinable, undeterminable: u, total };
}
