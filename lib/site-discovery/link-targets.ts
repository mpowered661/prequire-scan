import type { ExtractedLink, LinkPlacement, TargetObservation } from './types';
import { DEFAULT_TARGET_CHECK_BUDGET, HARD_MAX_TARGET_CHECKS } from './versions';

export interface LinkTargetCandidate {
  targetUrlNormalized: string;
  sourceLinkCount: number;
  placements: Set<LinkPlacement>;
}

export interface TargetSelection {
  candidates: LinkTargetCandidate[];
  selected: LinkTargetCandidate[];
  unselected: TargetObservation[];
  budget: number;
}

export function buildInternalTargetCandidates(links: ExtractedLink[]): LinkTargetCandidate[] {
  const byTarget = new Map<string, LinkTargetCandidate>();
  for (const link of links) {
    if (!link.eligibleForCheck || !link.isInternal || link.targetUrlNormalized === null) continue;
    const existing = byTarget.get(link.targetUrlNormalized);
    if (existing) {
      existing.sourceLinkCount += 1;
      existing.placements.add(link.placement);
    } else {
      byTarget.set(link.targetUrlNormalized, {
        targetUrlNormalized: link.targetUrlNormalized,
        sourceLinkCount: 1,
        placements: new Set([link.placement]),
      });
    }
  }
  return [...byTarget.values()].sort(compareCandidates);
}

export function selectTargets(links: ExtractedLink[], configuredBudget?: number): TargetSelection {
  const budget = Math.min(configuredBudget ?? DEFAULT_TARGET_CHECK_BUDGET, HARD_MAX_TARGET_CHECKS);
  const candidates = buildInternalTargetCandidates(links);
  const selected = candidates.slice(0, budget);
  const unselected = candidates.slice(budget).map(candidate => unchecked(candidate, 'target_budget_exhausted'));
  return { candidates, selected, unselected, budget };
}

export function unchecked(candidate: LinkTargetCandidate, reason: string): TargetObservation {
  return {
    targetUrlNormalized: candidate.targetUrlNormalized,
    checkState: 'unchecked',
    uncheckedReason: reason,
    classification: null,
    httpStatus: null,
    redirectTargetUrl: null,
    redirectLeftOrigin: null,
    redirectHops: 0,
    methodUsed: null,
    responseMs: null,
    sourceLinkCount: candidate.sourceLinkCount,
    checkedAt: null,
  };
}

function compareCandidates(a: LinkTargetCandidate, b: LinkTargetCandidate): number {
  if (a.sourceLinkCount !== b.sourceLinkCount) return b.sourceLinkCount - a.sourceLinkCount;
  const placement = placementRank(b) - placementRank(a);
  if (placement !== 0) return placement;
  return a.targetUrlNormalized < b.targetUrlNormalized ? -1 : a.targetUrlNormalized > b.targetUrlNormalized ? 1 : 0;
}

function placementRank(candidate: LinkTargetCandidate): number {
  if (candidate.placements.has('footer')) return 3;
  if (candidate.placements.has('nav')) return 2;
  if (candidate.placements.has('body')) return 1;
  return 0;
}
