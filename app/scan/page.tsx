'use client';

import { useState, useRef, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import type { ScanResult, CategoryResult, CheckItem } from '@/lib/scanPrompt';

// ── Streaming progress ───────────────────────────────────────
const STAGES = [
  { key: 'fetching',   label: 'Fetching page',       pct: 25  },
  { key: 'analyzing',  label: 'Analyzing content',    pct: 50  },
  { key: 'scoring',    label: 'Calculating score',    pct: 75  },
  { key: 'complete',   label: 'Complete',             pct: 100 },
] as const;

type StageKey = typeof STAGES[number]['key'];

function ScanProgress({ stage, message }: { stage: StageKey | null; message: string }) {
  const stageIndex = STAGES.findIndex((s) => s.key === stage);
  const pct = stageIndex >= 0 ? STAGES[stageIndex].pct : 0;

  return (
    <div className="max-w-xl mx-auto mt-8 text-left">
      {/* Status message */}
      <div className="flex items-center gap-2 mb-4">
        <svg className="animate-spin w-4 h-4 text-orange-400 flex-shrink-0" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
          <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <span className="text-sm text-slate-300 font-mono">{message || 'Starting…'}</span>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden mb-5">
        <div
          className="h-full bg-orange-500 rounded-full transition-all duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Step indicators */}
      <div className="flex justify-between">
        {STAGES.map((s, i) => {
          const done = stageIndex >= i;
          return (
            <div key={s.key} className="flex flex-col items-center gap-1">
              <div
                className={`w-2 h-2 rounded-full transition-colors duration-300 ${
                  done ? 'bg-orange-500' : 'bg-slate-700'
                }`}
              />
              <span className={`text-xs transition-colors duration-300 ${
                done ? 'text-slate-300' : 'text-slate-600'
              }`}>
                {s.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Category metadata ────────────────────────────────────────
const CATEGORIES: {
  key: keyof ScanResult['categories'];
  label: string;
  icon: string;
}[] = [
  { key: 'contentQuality', label: 'Content Quality', icon: '📝' },
  { key: 'schemaMarkup', label: 'Schema Markup', icon: '🏗️' },
  { key: 'performance', label: 'Performance', icon: '⚡' },
  { key: 'accessibility', label: 'Accessibility', icon: '♿' },
];

// ── Gauge SVG ────────────────────────────────────────────────
function ScoreGauge({ score }: { score: number }) {
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
        <circle
          cx="72"
          cy="72"
          r={radius}
          fill="none"
          stroke="#1e2a3a"
          strokeWidth="10"
        />
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
          style={{
            transition: 'stroke-dashoffset 1.2s ease, stroke 0.6s ease',
          }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-4xl font-bold text-white">{score}</span>
        <span className="text-xs text-slate-400 uppercase tracking-widest">
          AEO Score
        </span>
      </div>
    </div>
  );
}

// ── Check item row ───────────────────────────────────────────
const STATUS_STYLES = {
  pass: { dot: 'bg-green-500', text: 'text-green-400' },
  warn: { dot: 'bg-orange-400', text: 'text-orange-300' },
  fail: { dot: 'bg-red-500', text: 'text-red-400' },
} as const;

function CheckRow({ check }: { check: CheckItem }) {
  const styles = STATUS_STYLES[check.status];
  return (
    <div className="flex items-start gap-3 py-2">
      <span
        className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${styles.dot}`}
      />
      <div className="flex-1 min-w-0">
        <span className="text-sm text-slate-200">{check.label}</span>
        <p className="text-xs text-slate-500 mt-0.5">{check.detail}</p>
      </div>
      <span className={`text-xs font-mono uppercase ${styles.text}`}>
        {check.status}
      </span>
    </div>
  );
}

// ── Category card ────────────────────────────────────────────
const FREE_RECS = 2;

function CategoryCard({
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
    data.score >= 70
      ? 'text-green-400'
      : data.score >= 45
      ? 'text-orange-400'
      : 'text-red-400';
  const barColor =
    data.score >= 70
      ? 'bg-green-500'
      : data.score >= 45
      ? 'bg-orange-400'
      : 'bg-red-500';

  return (
    <div className="bg-[#0d1525] border border-slate-800 rounded-2xl p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-xl">{icon}</span>
          <h3 className="font-semibold text-slate-100 text-lg">{label}</h3>
        </div>
        <span className={`text-2xl font-bold ${color}`}>{data.score}</span>
      </div>

      {/* Score bar */}
      <div className="h-1.5 bg-slate-800 rounded-full mb-5 overflow-hidden">
        <div
          className={`h-full ${barColor} rounded-full transition-all duration-1000`}
          style={{ width: `${data.score}%` }}
        />
      </div>

      {/* Checks */}
      <div className="divide-y divide-slate-800/60 mb-5">
        {data.checks.map((c, i) => (
          <CheckRow key={i} check={c} />
        ))}
      </div>

      {/* Recommendations */}
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

          {/* Gated recs */}
          {data.recommendations.length > FREE_RECS && !isUnlocked && (
            <li className="relative">
              <div className="blur-sm select-none pointer-events-none space-y-2">
                {data.recommendations.slice(FREE_RECS).map((rec, i) => (
                  <div
                    key={i}
                    className="flex gap-2 text-sm text-slate-300"
                  >
                    <span className="text-orange-500">→</span>
                    {rec}
                  </div>
                ))}
              </div>
              <div className="absolute inset-0 flex items-center justify-center">
                <a
                  href="https://app.prequire.ai/signup"
                  className="bg-orange-500 hover:bg-orange-400 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                >
                  Sign up free to unlock
                </a>
              </div>
            </li>
          )}

          {isUnlocked &&
            data.recommendations.slice(FREE_RECS).map((rec, i) => (
              <li
                key={`u-${i}`}
                className="flex gap-2 text-sm text-slate-300"
              >
                <span className="text-orange-500 flex-shrink-0">→</span>
                {rec}
              </li>
            ))}
        </ul>
      </div>
    </div>
  );
}

// ── Inner page (needs useSearchParams → must be in Suspense) ─
function ScanPageInner() {
  const searchParams = useSearchParams();
  const initialUrl = searchParams.get('url') ?? '';
  const [url, setUrl] = useState(initialUrl);
  const [loading, setLoading] = useState(!!initialUrl.trim());
  const [error, setError] = useState('');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [scannedUrl, setScannedUrl] = useState('');
  const [streamStage, setStreamStage] = useState<StageKey | null>(null);
  const [streamMessage, setStreamMessage] = useState('');
  const resultsRef = useRef<HTMLDivElement>(null);
  const autoRanRef = useRef(false);

  const utmParams = {
    utm_source: searchParams.get('utm_source'),
    utm_medium: searchParams.get('utm_medium'),
    utm_campaign: searchParams.get('utm_campaign'),
    utm_content: searchParams.get('utm_content'),
    utm_term: searchParams.get('utm_term'),
  };

  async function runScan(urlStr: string) {
    setLoading(true);
    setError('');
    setResult(null);
    setStreamStage(null);
    setStreamMessage('');

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlStr.trim(), ...utmParams }),
      });

      if (!res.body) {
        setError('No response from server. Please try again.');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // keep incomplete last line

        for (const line of lines) {
          if (!line.trim()) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          const stage = event.stage as string;

          if (stage === 'error') {
            setError((event.message as string) ?? 'Something went wrong. Please try again.');
            return;
          }

          if (stage === 'complete') {
            const payload = event.data as { result: ScanResult; url: string };
            setStreamStage('complete');
            setStreamMessage('Complete');
            setResult(payload.result);
            setScannedUrl(payload.url);
            setTimeout(
              () => resultsRef.current?.scrollIntoView({ behavior: 'smooth' }),
              300
            );
            return;
          }

          setStreamStage(stage as StageKey);
          setStreamMessage((event.message as string) ?? '');
        }
      }
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleScan(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    await runScan(url);
  }

  useEffect(() => {
    if (autoRanRef.current) return;
    const paramUrl = searchParams.get('url') ?? '';
    if (!paramUrl.trim()) {
      setLoading(false);
      return;
    }
    autoRanRef.current = true;
    runScan(paramUrl);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scoreLabel = result
    ? result.overallScore >= 70
      ? 'Strong AEO readiness'
      : result.overallScore >= 45
      ? 'Moderate — gaps to address'
      : 'Significant AEO gaps'
    : '';

  return (
    <main className="min-h-screen bg-[#060d18] text-slate-100">
      {/* Hero */}
      <section className="max-w-3xl mx-auto px-4 pt-20 pb-12 text-center">
        <div className="inline-flex items-center gap-2 bg-orange-500/10 border border-orange-500/20 rounded-full px-4 py-1.5 mb-6">
          <span className="w-2 h-2 bg-orange-500 rounded-full animate-pulse" />
          <span className="text-xs font-mono text-orange-400 uppercase tracking-wider">
            Free AEO Audit
          </span>
        </div>

        <h1 className="text-4xl sm:text-5xl font-bold mb-4 leading-tight">
          Is your page ready for
          <br />
          <span className="text-orange-400">AI answer engines?</span>
        </h1>

        <p className="text-slate-400 text-lg mb-10">
          Paste any URL. Get a free AEO score across 4 categories — content,
          schema, performance, and accessibility.
        </p>

        {/* Input form */}
        <form
          onSubmit={handleScan}
          className="flex gap-3 max-w-xl mx-auto"
        >
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://yoursite.com/page"
            className="flex-1 bg-[#0d1525] border border-slate-700 rounded-xl px-4 py-3 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-orange-500 transition-colors font-mono text-sm"
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading || !url.trim()}
            className="bg-orange-500 hover:bg-orange-400 disabled:bg-orange-500/40 disabled:cursor-not-allowed text-white font-semibold px-6 py-3 rounded-xl transition-colors whitespace-nowrap"
          >
            {loading ? 'Scanning…' : 'Scan Page'}
          </button>
        </form>

        {error && <p className="mt-4 text-red-400 text-sm">{error}</p>}

        {loading && (
          <ScanProgress stage={streamStage} message={streamMessage} />
        )}
      </section>

      {/* Results */}
      {result && (
        <section ref={resultsRef} className="max-w-5xl mx-auto px-4 pb-20">
          {/* Score hero card */}
          <div className="bg-[#0d1525] border border-slate-800 rounded-2xl p-8 mb-8 flex flex-col sm:flex-row items-center gap-8">
            <ScoreGauge score={result.overallScore} />
            <div className="text-center sm:text-left">
              <p className="text-xs font-mono text-slate-500 mb-1 truncate max-w-xs">
                {scannedUrl}
              </p>
              <h2 className="text-2xl font-bold mb-2">{scoreLabel}</h2>
              <p className="text-slate-400 text-sm leading-relaxed max-w-md">
                {result.summary}
              </p>
            </div>
            <a
              href="https://app.prequire.ai/signup"
              className="sm:ml-auto flex-shrink-0 bg-orange-500 hover:bg-orange-400 text-white font-semibold px-5 py-2.5 rounded-xl transition-colors text-sm"
            >
              Get full report free →
            </a>
          </div>

          {/* Category grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {CATEGORIES.map(({ key, label, icon }) => (
              <CategoryCard
                key={key}
                label={label}
                icon={icon}
                data={result.categories[key]}
                isUnlocked={false}
              />
            ))}
          </div>

          {/* Bottom CTA */}
          <div className="mt-10 bg-gradient-to-r from-orange-500/10 to-orange-600/5 border border-orange-500/20 rounded-2xl p-8 text-center">
            <h3 className="text-xl font-bold mb-2">
              Ready to fix your AEO gaps?
            </h3>
            <p className="text-slate-400 text-sm mb-5">
              Sign up free to unlock all recommendations, track your score
              over time, and extract shadow queries for your niche.
            </p>
            <a
              href="https://app.prequire.ai/signup"
              className="inline-block bg-orange-500 hover:bg-orange-400 text-white font-semibold px-8 py-3 rounded-xl transition-colors"
            >
              Sign up free — no credit card
            </a>
          </div>
        </section>
      )}
    </main>
  );
}

// ── Default export — wraps in Suspense for useSearchParams ───
export default function ScanPage() {
  return (
    <Suspense>
      <ScanPageInner />
    </Suspense>
  );
}
