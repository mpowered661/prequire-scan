'use client';

import { useState, useRef, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import type { ScanResult } from '@/lib/scanPrompt';
import { ScoreGauge, CategoryCard } from '@/components/ScanDisplay';
import { CATEGORIES, scoreLabel } from '@/lib/scanUtils';

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

// ── Inner page (needs useSearchParams → must be in Suspense) ─
function ScanPageInner() {
  const searchParams = useSearchParams();
  const initialUrl = searchParams.get('url') ?? '';
  const [url, setUrl] = useState(initialUrl);
  const [loading, setLoading] = useState(!!initialUrl.trim());
  const [error, setError] = useState('');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [scannedUrl, setScannedUrl] = useState('');
  const [scanId, setScanId] = useState<string | null>(null);
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
    setScanId(null);
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
            const payload = event.data as { result: ScanResult; url: string; scan_id?: string };
            setStreamStage('complete');
            setStreamMessage('Complete');
            setResult(payload.result);
            setScannedUrl(payload.url);
            if (payload.scan_id) setScanId(payload.scan_id);
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

  const label = result ? scoreLabel(result.overallScore) : '';

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
              <h2 className="text-2xl font-bold mb-2">{label}</h2>
              <p className="text-slate-400 text-sm leading-relaxed max-w-md">
                {result.summary}
              </p>
            </div>
            <div className="sm:ml-auto flex-shrink-0 flex flex-col gap-2 items-end">
              {scanId && (
                <a
                  href={`https://scan.prequire.ai/report/${scanId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
                >
                  Share this report ↗
                </a>
              )}
              <a
                href="https://prequire.ai/#pricing"
                className="bg-orange-500 hover:bg-orange-400 text-white font-semibold px-5 py-2.5 rounded-xl transition-colors text-sm"
              >
                Get full access →
              </a>
            </div>
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
              Unlock all recommendations, track your score over time, and
              extract shadow queries for your niche with a full Prequire account.
            </p>
            <a
              href="https://prequire.ai/#pricing"
              className="inline-block bg-orange-500 hover:bg-orange-400 text-white font-semibold px-8 py-3 rounded-xl transition-colors"
            >
              See plans &amp; pricing
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
