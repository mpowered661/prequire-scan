import type { AeoReadinessReport, CrawlerResult, OverallStatus } from './types';
import { CRAWLERS } from './crawlers';
import { computeScore, effectiveStatus, isRobotsToken } from './scoring';

// Gate 1 score surface: the headline score never renders without its basis.
// A single threshold encodes exactly one rule — a score may not headline when
// most of its input signals are unknown.
export const LOW_COVERAGE_THRESHOLD = 0.5;

const DEF_BY_NAME = new Map(CRAWLERS.map((c) => [c.name, c]));

/**
 * Three kinds of evidence a crawler row can carry, never to be merged:
 * - simulated: we requested the page with the crawler's user-agent (not its verified IPs)
 * - robots_token: a robots.txt permission for a token that is never requested
 * A simulated row may still be undeterminable (challenge, refusal, 5xx, timeout).
 */
export type ResultTone = 'positive' | 'caution' | 'negative' | 'neutral';

export interface ResultLabel {
  kind: 'simulated' | 'robots_token';
  status: OverallStatus;
  label: string;
  tone: ResultTone;
}

export function resultLabel(r: CrawlerResult): ResultLabel {
  if (isRobotsToken(r, DEF_BY_NAME.get(r.crawler_name))) {
    const robots = r.tests?.robots_txt?.status;
    if (robots === 'disallowed') {
      return { kind: 'robots_token', status: 'blocked', label: 'Disallowed by robots.txt', tone: 'negative' };
    }
    if (robots === 'error') {
      return { kind: 'robots_token', status: 'undeterminable', label: 'robots.txt unverified', tone: 'neutral' };
    }
    return { kind: 'robots_token', status: r.overall_status, label: 'Permitted by robots.txt (not requested)', tone: 'neutral' };
  }
  const status = effectiveStatus(r);
  const label: Record<OverallStatus, [string, ResultTone]> = {
    accessible: ['Content received (simulated)', 'positive'],
    partial: ['Partial content (simulated)', 'caution'],
    blocked: ['Blocked', 'negative'],
    undeterminable: ['Undeterminable', 'neutral'],
  };
  return { kind: 'simulated', status, label: label[status][0], tone: label[status][1] };
}

export interface SimulatedCounts {
  total: number;
  accessible: number;
  partial: number;
  blocked: number;
  undeterminable: number;
  determinable: number;
}

export interface RobotsTokenCounts {
  total: number;
  permitted: number;
  disallowed: number;
  unverified: number;
}

export type VisibilityView =
  // Stored before 2026-07: coverage was never measured, so none is asserted and
  // the report never feeds an overall score.
  | { state: 'legacy'; score: number }
  | {
      state: 'sufficient' | 'insufficient';
      // Score over simulated, determinable requests only. In 'insufficient' it is
      // detail, never a headline; null when no simulated request was determinable.
      score: number | null;
      simulated: SimulatedCounts;
      robotsTokens: RobotsTokenCounts;
    };

export function visibilityView(report: Pick<AeoReadinessReport, 'summary' | 'crawler_results' | 'aeo_readiness_score'>): VisibilityView {
  if (typeof report.summary.undeterminable !== 'number') {
    return { state: 'legacy', score: report.aeo_readiness_score };
  }

  const simulated: SimulatedCounts = { total: 0, accessible: 0, partial: 0, blocked: 0, undeterminable: 0, determinable: 0 };
  const robotsTokens: RobotsTokenCounts = { total: 0, permitted: 0, disallowed: 0, unverified: 0 };

  for (const r of report.crawler_results) {
    const l = resultLabel(r);
    if (l.kind === 'robots_token') {
      robotsTokens.total += 1;
      if (l.status === 'blocked') robotsTokens.disallowed += 1;
      else if (l.status === 'undeterminable') robotsTokens.unverified += 1;
      else robotsTokens.permitted += 1;
    } else {
      simulated.total += 1;
      simulated[l.status] += 1;
    }
  }
  simulated.determinable = simulated.total - simulated.undeterminable;

  const score = simulated.determinable > 0 ? computeScore(report.crawler_results, CRAWLERS) : null;
  const sufficient = simulated.total > 0 && simulated.determinable / simulated.total >= LOW_COVERAGE_THRESHOLD;
  return { state: sufficient ? 'sufficient' : 'insufficient', score, simulated, robotsTokens };
}

/**
 * The single rule for an overall AEO score: it exists only when visibility rests
 * on sufficient verified coverage. Otherwise the citation score stands alone.
 */
export function overallScore(view: VisibilityView, citationScore: number): number | null {
  if (view.state !== 'sufficient' || view.score === null) return null;
  return Math.round((view.score + citationScore) / 2);
}
