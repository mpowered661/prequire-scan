import type { ScanResult } from './scanPrompt';

export const CATEGORIES: {
  key: keyof ScanResult['categories'];
  label: string;
  icon: string;
}[] = [
  { key: 'contentQuality', label: 'Content Quality', icon: '📝' },
  { key: 'schemaMarkup', label: 'Schema Markup', icon: '🏗️' },
  { key: 'performance', label: 'Performance', icon: '⚡' },
  { key: 'accessibility', label: 'Accessibility', icon: '♿' },
];

export function scoreLabel(score: number): string {
  return score >= 70
    ? 'Strong AEO readiness'
    : score >= 45
    ? 'Moderate — gaps to address'
    : 'Significant AEO gaps';
}
