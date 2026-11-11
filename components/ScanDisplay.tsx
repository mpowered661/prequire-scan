'use client';

import type { ScanResult, CategoryResult, AccessibilityCategory, CheckItem } from '@/lib/scanPrompt';
export type { ScanResult, CategoryResult, CheckItem };

import {
  scoreTone,
  accessibilitySummary,
  accessibilitySummaryText,
  ACCESSIBILITY_DISCLAIMER,
} from '@/lib/scanUtils';

export { CATEGORIES, scoreLabel } from '@/lib/scanUtils';

// This gauge shows the citation scan's score. It is not the overall AEO score,
// which also needs verified crawler visibility, so it is labelled for what it is.
export function ScoreGauge({ score }: { score: number }) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const color = scoreTone(score).stroke;

  return (
    <div className="relative w-36 h-36 mx-auto">
      <svg
        width="144"
        height="144"
        viewBox="0 0 144 144"
        style={{ transform: 'rotate(-90deg)' }}
      >
        <circle cx="72" cy="72" r={radius} fill="none" stroke="#1e2a3a" strokeWidth="10" />
        <circle
          cx="72"
          cy="72"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset,stroke] duration-[1200ms] ease-out motion-reduce:transition-none"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-4xl font-bold text-white">{score}</span>
        <span className="text-[10px] leading-tight text-slate-400 uppercase tracking-wider text-center">
          Citation
          <br />
          readiness
        </span>
      </div>
    </div>
  );
}

const STATUS_STYLES = {
  pass: { dot: 'bg-green-500', text: 'text-green-400', label: 'pass' },
  warn: { dot: 'bg-orange-400', text: 'text-orange-300', label: 'warn' },
  fail: { dot: 'bg-red-500', text: 'text-red-400', label: 'fail' },
  // Not scored: the property cannot be verified from fetched HTML alone.
  not_assessable: { dot: 'bg-slate-600', text: 'text-slate-400', label: 'not assessable' },
} as const;

export function CheckRow({ check }: { check: CheckItem }) {
  const styles = STATUS_STYLES[check.status] ?? STATUS_STYLES.not_assessable;
  return (
    <div className="flex items-start gap-3 py-2">
      <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${styles.dot}`} />
      <div className="flex-1 min-w-0">
        <span className="text-sm text-slate-200">{check.label}</span>
        <p className="text-xs text-slate-400 mt-0.5">{check.detail}</p>
      </div>
      <span className={`text-xs font-mono uppercase whitespace-nowrap ${styles.text}`}>{styles.label}</span>
    </div>
  );
}

const FREE_RECS = 2;

export function CategoryCard({
  categoryKey,
  label,
  icon,
  data,
  isUnlocked,
  fixHref,
}: {
  categoryKey: string;
  label: string;
  icon: string;
  data: CategoryResult | AccessibilityCategory;
  isUnlocked: boolean;
  fixHref: string;
}) {
  const score = data.score ?? 0;   // accessibility has no score and never shows one
  const tone = scoreTone(score);
  // Static-HTML accessibility is shown as check counts with its limits stated,
  // never as a 0–100 bar that would read as a full accessibility audit.
  const isAccessibility = categoryKey === 'accessibility';
  const a11y = isAccessibility ? accessibilitySummary(data.checks) : null;

  return (
    <div className="bg-[#0d1525] border border-slate-800 rounded-2xl p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-xl" aria-hidden="true">{icon}</span>
          <h2 className="font-semibold text-slate-100 text-lg">{label}</h2>
        </div>
        {!a11y && <span className={`text-2xl font-bold ${tone.text}`}>{score}</span>}
      </div>

      {a11y ? (
        <div className="mb-5">
          <p className="text-sm font-semibold text-slate-200">{accessibilitySummaryText(a11y)}</p>
          <p className="text-xs text-slate-400 mt-1 leading-relaxed">{ACCESSIBILITY_DISCLAIMER}</p>
        </div>
      ) : (
        <div className="h-1.5 bg-slate-800 rounded-full mb-5 overflow-hidden">
          <div className={`h-full ${tone.bar} rounded-full transition-all duration-1000 motion-reduce:transition-none`} style={{ width: `${score}%` }} />
        </div>
      )}

      <div className="divide-y divide-slate-800/60 mb-5">
        {data.checks.map((c, i) => (
          <CheckRow key={i} check={c} />
        ))}
      </div>

      <div>
        <p className="text-xs font-mono text-orange-400 uppercase tracking-wider mb-3">
          Recommendations
        </p>
        <ul className="space-y-2">
          {data.recommendations.slice(0, FREE_RECS).map((rec, i) => (
            <li key={i} className="flex gap-2 text-sm text-slate-300">
              <span className="text-orange-500 flex-shrink-0">→</span>
              {rec}
            </li>
          ))}

          {data.recommendations.length > FREE_RECS && !isUnlocked && (
            <li className="relative">
              <div className="blur-sm select-none pointer-events-none space-y-2">
                {data.recommendations.slice(FREE_RECS).map((rec, i) => (
                  <div key={i} className="flex gap-2 text-sm text-slate-300">
                    <span className="text-orange-500">→</span>
                    {rec}
                  </div>
                ))}
              </div>
              <div className="absolute inset-0 flex items-center justify-center">
                <a
                  href={fixHref}
                  className="bg-orange-500 hover:bg-orange-400 text-slate-950 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                >
                  Ask Prequire about these →
                </a>
              </div>
            </li>
          )}

          {isUnlocked &&
            data.recommendations.slice(FREE_RECS).map((rec, i) => (
              <li key={`u-${i}`} className="flex gap-2 text-sm text-slate-300">
                <span className="text-orange-500 flex-shrink-0">→</span>
                {rec}
              </li>
            ))}
        </ul>
      </div>
    </div>
  );
}
