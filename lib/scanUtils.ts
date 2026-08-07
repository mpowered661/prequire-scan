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
