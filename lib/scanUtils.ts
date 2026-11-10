import type { ScanResult } from './scanPrompt';

export const CATEGORIES: {
  key: keyof ScanResult['categories'];
  label: string;
  icon: string;
}[] = [
  { key: 'contentQuality', label: 'Content Quality', icon: '📝' },
  { key: 'schemaMarkup', label: 'Schema Markup', icon: '🏗️' },
  { key: 'performance', label: 'Performance', icon: '⚡' },
  // Static-HTML signals only; not scored into the overall AEO score and not a
  // WCAG/compliance assessment. Contrast and keyboard checks are reported as
  // not assessable (they require a rendered-page audit).
  { key: 'accessibility', label: 'Accessibility Signals (static HTML)', icon: '♿' },
];

export function scoreLabel(score: number): string {
  return score >= 70
    ? 'Strong AEO readiness'
    : score >= 45
    ? 'Moderate — gaps to address'
    : 'Significant AEO gaps';
}

// Machine-readable band matching scoreLabel's thresholds — stored with captured
// leads so a lead row is meaningful without re-deriving thresholds later.
export type ScoreBand = 'strong' | 'moderate' | 'weak';

export function scoreBand(score: number): ScoreBand {
  return score >= 70 ? 'strong' : score >= 45 ? 'moderate' : 'weak';
}

// The one set of score labels and colours for every page. Thresholds come only
// from scoreBand, so a number reads the same wherever it appears.
const BAND_LABEL: Record<ScoreBand, string> = {
  strong: 'Strong',
  moderate: 'Moderate',
  weak: 'Significant gaps',
};

const BAND_TONE: Record<ScoreBand, { text: string; bar: string; border: string; bg: string; stroke: string }> = {
  strong: { text: 'text-green-400', bar: 'bg-green-500', border: 'border-green-500', bg: 'bg-green-500/10 border-green-500/20', stroke: '#22c55e' },
  moderate: { text: 'text-orange-400', bar: 'bg-orange-400', border: 'border-orange-500', bg: 'bg-orange-500/10 border-orange-500/20', stroke: '#f97316' },
  weak: { text: 'text-red-400', bar: 'bg-red-500', border: 'border-red-500', bg: 'bg-red-500/10 border-red-500/20', stroke: '#ef4444' },
};

export function bandLabel(score: number): string {
  return BAND_LABEL[scoreBand(score)];
}

export function scoreTone(score: number) {
  return BAND_TONE[scoreBand(score)];
}

export interface AccessibilitySummary {
  passed: number;
  warned: number;
  failed: number;
  notAssessed: number;
  assessed: number;
}

// Static-HTML accessibility is reported as check counts, never as a 0–100 score:
// a percentage over the checks we could assess would read as a full audit.
// Not-assessable items are counted separately and never as failures.
export function accessibilitySummary(checks: { status: string }[]): AccessibilitySummary {
  const s: AccessibilitySummary = { passed: 0, warned: 0, failed: 0, notAssessed: 0, assessed: 0 };
  for (const c of checks) {
    if (c.status === 'pass') s.passed += 1;
    else if (c.status === 'warn') s.warned += 1;
    else if (c.status === 'fail') s.failed += 1;
    else s.notAssessed += 1;
  }
  s.assessed = s.passed + s.warned + s.failed;
  return s;
}

export function accessibilitySummaryText(s: AccessibilitySummary): string {
  const parts = [`${s.passed} of ${s.assessed} static checks passed`];
  if (s.warned) parts.push(`${s.warned} need review`);
  if (s.failed) parts.push(`${s.failed} failed`);
  if (s.notAssessed) parts.push(`${s.notAssessed} not assessed`);
  return parts.join(' · ');
}

export const ACCESSIBILITY_DISCLAIMER =
  'Static HTML signals only. Not included in the score, and not a complete WCAG or ADA accessibility assessment — colour contrast and keyboard access need a rendered-page audit and human testing.';
