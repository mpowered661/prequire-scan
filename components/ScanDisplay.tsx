'use client';

import type { ScanResult, CategoryResult, CheckItem } from '@/lib/scanPrompt';
export type { ScanResult, CategoryResult, CheckItem };

export { CATEGORIES, scoreLabel } from '@/lib/scanUtils';

export function ScoreGauge({ score }: { score: number }) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const color =
    score >= 70 ? '#22c55e' : score >= 45 ? '#f97316' : '#ef4444';

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
          style={{ transition: 'stroke-dashoffset 1.2s ease, stroke 0.6s ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-4xl font-bold text-white">{score}</span>
        <span className="text-xs text-slate-400 uppercase tracking-widest">AEO Score</span>
      </div>
    </div>
  );
}

const STATUS_STYLES = {
  pass: { dot: 'bg-green-500', text: 'text-green-400' },
  warn: { dot: 'bg-orange-400', text: 'text-orange-300' },
  fail: { dot: 'bg-red-500', text: 'text-red-400' },
} as const;

export function CheckRow({ check }: { check: CheckItem }) {
  const styles = STATUS_STYLES[check.status];
  return (
    <div className="flex items-start gap-3 py-2">
      <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${styles.dot}`} />
      <div className="flex-1 min-w-0">
        <span className="text-sm text-slate-200">{check.label}</span>
        <p className="text-xs text-slate-500 mt-0.5">{check.detail}</p>
      </div>
      <span className={`text-xs font-mono uppercase ${styles.text}`}>{check.status}</span>
    </div>
  );
}

const FREE_RECS = 2;

export function CategoryCard({
  label,
  icon,
  data,
  isUnlocked,
}: {
  label: string;
  icon: string;
  data: CategoryResult;
  isUnlocked: boolean;
}) {
  const color =
    data.score >= 70 ? 'text-green-400' : data.score >= 45 ? 'text-orange-400' : 'text-red-400';
  const barColor =
    data.score >= 70 ? 'bg-green-500' : data.score >= 45 ? 'bg-orange-400' : 'bg-red-500';

  return (
    <div className="bg-[#0d1525] border border-slate-800 rounded-2xl p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-xl">{icon}</span>
          <h3 className="font-semibold text-slate-100 text-lg">{label}</h3>
        </div>
        <span className={`text-2xl font-bold ${color}`}>{data.score}</span>
      </div>

      <div className="h-1.5 bg-slate-800 rounded-full mb-5 overflow-hidden">
        <div className={`h-full ${barColor} rounded-full transition-all duration-1000`} style={{ width: `${data.score}%` }} />
      </div>

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
                  href="https://prequire.ai/#pricing"
                  className="bg-orange-500 hover:bg-orange-400 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                >
                  Get full access →
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
