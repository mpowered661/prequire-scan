'use client';

import { useState, useRef, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import type { ScanResult } from '@/lib/scanPrompt';
import type { AeoReadinessReport } from '@/lib/aeo-readiness/types';

const PASSTHROUGH = ['email', 'name', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

// ── Visibility (readiness) state ──────────────────────────────────────────────

type VisibilityState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; checkId: string; score: number; report: AeoReadinessReport }
  | { status: 'error'; message: string };

// ── Citation (scan) state ─────────────────────────────────────────────────────

type CitationState =
  | { status: 'idle' }
  | { status: 'fetching' }
  | { status: 'analyzing' }
  | { status: 'scoring' }
  | { status: 'done'; scanId: string | null; score: number; result: ScanResult; url: string }
  | { status: 'error'; message: string };

// ── Helpers ───────────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 80) return 'text-green-400';
  if (score >= 60) return 'text-yellow-400';
  return 'text-red-400';
}

function scoreLabel(score: number): string {
  if (score >= 80) return 'Strong';
  if (score >= 60) return 'Needs work';
  return 'At risk';
}

function scoreBg(score: number): string {
  if (score >= 80) return 'bg-green-500/10 border-green-500/20';
  if (score >= 60) return 'bg-yellow-500/10 border-yellow-500/20';
  return 'bg-red-500/10 border-red-500/20';
}

function Spinner() {
  return (
    <div className="w-6 h-6 border-2 border-slate-700 border-t-orange-500 rounded-full animate-spin" />
  );
}

// ── Main inner component ──────────────────────────────────────────────────────

function OverviewPageInner() {
  const searchParams = useSearchParams();
  const url = searchParams.get('url') ?? '';

  const [vis, setVis] = useState<VisibilityState>({ status: 'idle' });
  const [cit, setCit] = useState<CitationState>({ status: 'idle' });
  const hasRun = useRef(false);

  function buildPassthrough(): Record<string, string> {
    const out: Record<string, string> = {};
    PASSTHROUGH.forEach((k) => {
      const v = searchParams.get(k);
      if (v) out[k] = v;
    });
    return out;
  }

  async function runVisibility(targetUrl: string) {
    setVis({ status: 'loading' });
    try {
      const res = await fetch('/api/aeo-readiness-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
      });
      const json = await res.json();
      if (!res.ok) {
        setVis({ status: 'error', message: json.error ?? `HTTP ${res.status}` });
        return;
      }
      setVis({
        status: 'done',
        checkId: json.check_id,
        score: json.score,
        report: json.report,
      });
    } catch {
      setVis({ status: 'error', message: 'Could not run visibility check.' });
    }
  }

  async function runCitation(targetUrl: string) {
    setCit({ status: 'fetching' });
    try {
      const pass = buildPassthrough();
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl, ...pass }),
      });

      if (!res.ok || !res.body) {
        setCit({ status: 'error', message: `HTTP ${res.status}` });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(line); } catch { continue; }
          const stage = event.stage as string;
          if (stage === 'fetching')  setCit({ status: 'fetching' });
          if (stage === 'analyzing') setCit({ status: 'analyzing' });
          if (stage === 'scoring')   setCit({ status: 'scoring' });
          if (stage === 'error') {
            setCit({ status: 'error', message: (event.message as string) ?? 'Scan failed.' });
            return;
          }
          if (stage === 'complete') {
            const data = event.data as { result: ScanResult; url: string; scan_id: string | null };
            setCit({
              status: 'done',
              scanId: data.scan_id,
              score: data.result.overallScore,
              result: data.result,
              url: data.url,
            });
            return;
          }
        }
      }
    } catch {
      setCit({ status: 'error', message: 'Could not run citation check.' });
    }
  }

  useEffect(() => {
    if (hasRun.current || !url.trim()) return;
    hasRun.current = true;
    runVisibility(url);
    runCitation(url);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hostname = (() => {
    try {
      return new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
    } catch {
      return url;
    }
  })();

  const visScore = vis.status === 'done' ? vis.score : null;
  const citScore = cit.status === 'done' ? cit.score : null;
  const combinedScore =
    visScore !== null && citScore !== null
      ? Math.round((visScore + citScore) / 2)
      : null;

  // Show a note on citation card if visibility is blocked
  const visBlocked =
    vis.status === 'done' &&
    (vis.report.summary.blocked > 0 || vis.score < 60);

  return (
    <main className="min-h-screen bg-[#060d18] text-slate-100">
      {/* Top bar */}
      <div className="border-b border-slate-800">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <a
            href="/"
            className="text-xs font-mono text-orange-400 hover:text-orange-300 transition-colors uppercase tracking-wider"
          >
            ← Run another scan
          </a>
          {combinedScore !== null && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-slate-500 uppercase tracking-wider">
                Prequire AEO Score
              </span>
              <span className={`text-xl font-bold font-mono ${scoreColor(combinedScore)}`}>
                {combinedScore}
                <span className="text-sm text-slate-500">/100</span>
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-10 space-y-6">
        {/* URL header */}
        <div>
          <p className="text-xs font-mono text-slate-500 uppercase tracking-wider mb-1">Scanning</p>
          <p className="text-lg font-mono text-slate-200 truncate">{hostname}</p>
        </div>

        {/* Combined score hero (once both are done) */}
        {combinedScore !== null && (
          <div className={`border rounded-2xl p-6 flex items-center gap-6 ${scoreBg(combinedScore)}`}>
            <div className="text-center">
              <div className={`text-5xl font-bold font-mono ${scoreColor(combinedScore)}`}>
                {combinedScore}
              </div>
              <div className="text-xs text-slate-500 mt-1">/ 100</div>
            </div>
            <div>
              <p className={`text-lg font-semibold ${scoreColor(combinedScore)}`}>
                {scoreLabel(combinedScore)}
              </p>
              <p className="text-sm text-slate-400 mt-0.5">Prequire AEO Score</p>
              <p className="text-xs text-slate-600 mt-1">50/50 average of Visibility + Citation</p>
            </div>
          </div>
        )}

        {/* Two-column cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

          {/* ── Visibility Card ── */}
          <div className="bg-[#0d1525] border border-slate-800 rounded-2xl p-6 flex flex-col gap-4">
            <div>
              <p className="text-xs font-mono text-orange-400 uppercase tracking-wider mb-1">
                AEO Readiness and Visibility Check
              </p>
              <p className="text-sm text-slate-400">Can AI engines reach and read your site?</p>
            </div>

            {vis.status === 'idle' && (
              <div className="flex items-center gap-2 text-slate-500 text-sm">
                <Spinner />
                <span>Starting…</span>
              </div>
            )}

            {vis.status === 'loading' && (
              <div className="flex items-center gap-2 text-slate-400 text-sm">
                <Spinner />
                <span>Checking crawler access…</span>
              </div>
            )}

            {vis.status === 'error' && (
              <div className="space-y-3">
                <p className="text-red-400 text-sm">{vis.message}</p>
                <button
                  onClick={() => runVisibility(url)}
                  className="text-xs font-mono text-orange-400 hover:text-orange-300 underline"
                >
                  Retry
                </button>
              </div>
            )}

            {vis.status === 'done' && (
              <div className="space-y-4">
                <div className="flex items-end gap-3">
                  <span className={`text-4xl font-bold font-mono ${scoreColor(vis.score)}`}>
                    {vis.score}
                  </span>
                  <span className="text-slate-500 text-sm pb-1">/ 100</span>
                  <span className={`text-sm pb-1 ${scoreColor(vis.score)}`}>
                    {scoreLabel(vis.score)}
                  </span>
                </div>

                {/* Summary row */}
                <div className="grid grid-cols-3 gap-2 text-center">
                  {[
                    { label: 'Accessible', val: vis.report.summary.accessible, color: 'text-green-400' },
                    { label: 'Partial', val: vis.report.summary.partial, color: 'text-yellow-400' },
                    { label: 'Blocked', val: vis.report.summary.blocked, color: 'text-red-400' },
                  ].map(({ label, val, color }) => (
                    <div key={label} className="bg-slate-800/50 rounded-lg py-2">
                      <div className={`text-xl font-bold font-mono ${color}`}>{val}</div>
                      <div className="text-xs text-slate-500">{label}</div>
                    </div>
                  ))}
                </div>

                {vis.report.llms_txt.present && (
                  <p className="text-xs text-green-400">
                    llms.txt detected
                  </p>
                )}

                {vis.report.summary.primary_blocker && (
                  <p className="text-xs text-yellow-400">
                    Primary blocker: {vis.report.summary.primary_blocker}
                  </p>
                )}

                <a
                  href={`/readiness/${vis.checkId}`}
                  className="inline-block text-xs font-mono text-orange-400 hover:text-orange-300 transition-colors underline"
                >
                  Full visibility report →
                </a>
              </div>
            )}
          </div>

          {/* ── Citation Card ── */}
          <div className="bg-[#0d1525] border border-slate-800 rounded-2xl p-6 flex flex-col gap-4">
            <div>
              <p className="text-xs font-mono text-orange-400 uppercase tracking-wider mb-1">
                Citation Check
              </p>
              <p className="text-sm text-slate-400">Is your content built to get cited?</p>
            </div>

            {(cit.status === 'idle' || cit.status === 'fetching') && (
              <div className="flex items-center gap-2 text-slate-400 text-sm">
                <Spinner />
                <span>Fetching page…</span>
              </div>
            )}

            {cit.status === 'analyzing' && (
              <div className="flex items-center gap-2 text-slate-400 text-sm">
                <Spinner />
                <span>Analyzing with AI…</span>
              </div>
            )}

            {cit.status === 'scoring' && (
              <div className="flex items-center gap-2 text-slate-400 text-sm">
                <Spinner />
                <span>Calculating score…</span>
              </div>
            )}

            {cit.status === 'error' && (
              <div className="space-y-3">
                <p className="text-red-400 text-sm">{cit.message}</p>
                <button
                  onClick={() => runCitation(url)}
                  className="text-xs font-mono text-orange-400 hover:text-orange-300 underline"
                >
                  Retry
                </button>
              </div>
            )}

            {cit.status === 'done' && (
              <div className="space-y-4">
                <div className="flex items-end gap-3">
                  <span className={`text-4xl font-bold font-mono ${scoreColor(cit.score)}`}>
                    {cit.score}
                  </span>
                  <span className="text-slate-500 text-sm pb-1">/ 100</span>
                  <span className={`text-sm pb-1 ${scoreColor(cit.score)}`}>
                    {scoreLabel(cit.score)}
                  </span>
                </div>

                {/* Category scores */}
                <div className="space-y-1.5">
                  {(Object.entries(cit.result.categories) as [string, { score: number }][]).map(
                    ([key, cat]) => {
                      const labels: Record<string, string> = {
                        contentQuality: 'Content Quality',
                        schemaMarkup: 'Schema Markup',
                        performance: 'Performance',
                        accessibility: 'Accessibility',
                      };
                      return (
                        <div key={key} className="flex items-center gap-3">
                          <span className="text-xs text-slate-500 w-32 shrink-0">{labels[key] ?? key}</span>
                          <div className="flex-1 bg-slate-800 rounded-full h-1.5">
                            <div
                              className={`h-1.5 rounded-full ${cat.score >= 80 ? 'bg-green-500' : cat.score >= 60 ? 'bg-yellow-500' : 'bg-red-500'}`}
                              style={{ width: `${cat.score}%` }}
                            />
                          </div>
                          <span className={`text-xs font-mono w-8 text-right ${scoreColor(cat.score)}`}>
                            {cat.score}
                          </span>
                        </div>
                      );
                    }
                  )}
                </div>

                {visBlocked && (
                  <p className="text-xs text-yellow-400">
                    Note: some AI crawlers are blocked — citation potential may be limited until visibility is fixed.
                  </p>
                )}

                {cit.scanId ? (
                  <a
                    href={`/report/${cit.scanId}`}
                    className="inline-block text-xs font-mono text-orange-400 hover:text-orange-300 transition-colors underline"
                  >
                    Full citation report →
                  </a>
                ) : (
                  <p className="text-xs text-slate-600">Full report unavailable (save failed)</p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Summary blurb (once both done) */}
        {cit.status === 'done' && (
          <div className="bg-[#0d1525] border border-slate-800 rounded-2xl p-5">
            <p className="text-xs font-mono text-slate-500 uppercase tracking-wider mb-2">Summary</p>
            <p className="text-sm text-slate-300 leading-relaxed">{cit.result.summary}</p>
          </div>
        )}

        {/* No URL fallback */}
        {!url.trim() && (
          <div className="text-center py-20">
            <p className="text-slate-400 mb-4">No URL provided.</p>
            <a href="/" className="text-orange-400 hover:text-orange-300 underline text-sm">
              Run a scan →
            </a>
          </div>
        )}
      </div>
    </main>
  );
}

export default function OverviewPage() {
  return (
    <Suspense>
      <OverviewPageInner />
    </Suspense>
  );
}
