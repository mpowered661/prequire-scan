'use client';

import { useState, useRef, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import type { ScanResult } from '@/lib/scanPrompt';
import type { AeoReadinessReport } from '@/lib/aeo-readiness/types';
import { visibilityView, overallScore } from '@/lib/aeo-readiness/score-surface';
import { EmailReportForm } from '@/components/EmailReportForm';
import { FixGapsLink } from '@/components/FixGapsLink';
import { fixHref } from '@/lib/fixLink';
import {
  scoreBand,
  bandLabel,
  scoreTone,
  accessibilitySummary,
  accessibilitySummaryText,
  ACCESSIBILITY_DISCLAIMER,
} from '@/lib/scanUtils';
import { track } from '@/lib/track';
import { requestHomepageReport, type ReportRequestOutcome } from '@/lib/reportQueue';

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

// Labels and colours come from scanUtils so every page uses one set of thresholds.
function scoreColor(score: number): string {
  return scoreTone(score).text;
}

function scoreLabel(score: number): string {
  return bandLabel(score);
}

function scoreBg(score: number): string {
  return scoreTone(score).bg;
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
  const reportRequested = useRef(false);
  const [report, setReport] = useState<ReportRequestOutcome | { status: 'pending' } | null>(null);
  const homepageEmail = (searchParams.get('email') ?? '').trim();

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
            track('scan_completed', {
              surface: 'overview',
              band: scoreBand(data.result.overallScore),
              ...(data.scan_id ? { scan_id: data.scan_id } : {}),
            });
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

  // Visitors who arrived with ?email= (the prequire.ai homepage form) were promised
  // the report by email and are not shown the email form below, so request it here:
  // consent record first, then the queue, tied to the scan on screen.
  async function requestReport() {
    if (cit.status !== 'done') return;
    setReport({ status: 'pending' });
    const outcome = await requestHomepageReport({
      email: homepageEmail,
      name: searchParams.get('name'),
      url: cit.url,
      scanId: cit.scanId,
      score: cit.score,
      utm: {
        utm_source: searchParams.get('utm_source'),
        utm_medium: searchParams.get('utm_medium'),
        utm_campaign: searchParams.get('utm_campaign'),
        utm_content: searchParams.get('utm_content'),
        utm_term: searchParams.get('utm_term'),
      },
    });
    setReport(outcome);
    track(outcome.status === 'queued' ? 'report_delivery_succeeded' : 'report_delivery_failed', {
      surface: 'overview',
      ...(outcome.status !== 'queued' ? { reason: outcome.status === 'failed' ? `${outcome.step}_failed` : outcome.status } : {}),
      ...(cit.scanId ? { scan_id: cit.scanId } : {}),
    });
  }

  useEffect(() => {
    if (cit.status !== 'done' || !homepageEmail || reportRequested.current) return;
    reportRequested.current = true;
    void requestReport();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cit]);

  const hostname = (() => {
    try {
      return new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
    } catch {
      return url;
    }
  })();

  const visView = vis.status === 'done' ? visibilityView(vis.report) : null;
  const citScore = cit.status === 'done' ? cit.score : null;
  // An overall AEO score exists only when crawler visibility rests on sufficient
  // verified coverage; otherwise the citation score is presented on its own.
  const combinedScore = visView && citScore !== null ? overallScore(visView, citScore) : null;
  const citationOnly = visView !== null && citScore !== null && combinedScore === null;

  // Show a note on citation card only for blocks that were actually observed.
  const visBlocked = visView !== null && visView.state !== 'legacy' && visView.simulated.blocked > 0;

  const fix =
    cit.status === 'done'
      ? fixHref({ url: cit.url, scanId: cit.scanId, checkId: vis.status === 'done' ? vis.checkId : null })
      : null;

  return (
    <main id="main-content" className="min-h-screen bg-[#060d18] text-slate-100">
      {/* Top bar */}
      <div className="border-b border-slate-800">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <a
            href="/"
            className="text-xs font-mono text-orange-400 hover:text-orange-300 transition-colors uppercase tracking-wider"
          >
            ← Run another scan
          </a>
          {(combinedScore !== null || (citationOnly && citScore !== null)) && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-slate-400 uppercase tracking-wider">
                {combinedScore !== null ? 'Prequire AEO Score' : 'Citation readiness'}
              </span>
              <span className={`text-xl font-bold font-mono ${scoreColor(combinedScore ?? citScore ?? 0)}`}>
                {combinedScore ?? citScore}
                <span className="text-sm text-slate-400">/100</span>
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-10 space-y-6">
        {/* URL header */}
        <div>
          <p className="text-xs font-mono text-slate-400 uppercase tracking-wider mb-1">Scanning</p>
          <h1 className="text-lg font-mono text-slate-200 truncate">{hostname}</h1>
        </div>

        {/* Combined score hero (once both are done) */}
        {combinedScore !== null && (
          <div className={`border rounded-2xl p-6 flex items-center gap-6 ${scoreBg(combinedScore)}`}>
            <div className="text-center">
              <div className={`text-5xl font-bold font-mono ${scoreColor(combinedScore)}`}>
                {combinedScore}
              </div>
              <div className="text-xs text-slate-400 mt-1">/ 100</div>
            </div>
            <div>
              <p className={`text-lg font-semibold ${scoreColor(combinedScore)}`}>
                {scoreLabel(combinedScore)}
              </p>
              <p className="text-sm text-slate-400 mt-0.5">Prequire AEO Score</p>
              <p className="text-xs text-slate-400 mt-1">
                50/50 average of Visibility + Citation
                {visView && visView.state === 'sufficient' &&
                  ` · visibility based on ${visView.simulated.determinable} of ${visView.simulated.total} simulated crawler requests`}
              </p>
            </div>
          </div>
        )}

        {/* No overall score: visibility could not be verified, so the citation
            score — which stands on its own evidence — headlines alone. */}
        {citationOnly && citScore !== null && visView && (
          <div className={`border rounded-2xl p-6 flex items-center gap-6 ${scoreBg(citScore)}`}>
            <div className="text-center">
              <div className={`text-5xl font-bold font-mono ${scoreColor(citScore)}`}>{citScore}</div>
              <div className="text-xs text-slate-400 mt-1">/ 100</div>
            </div>
            <div>
              <p className={`text-lg font-semibold ${scoreColor(citScore)}`}>{scoreLabel(citScore)}</p>
              <p className="text-sm text-slate-300 mt-0.5">Citation readiness</p>
              <p className="text-xs text-slate-400 mt-1">
                No overall AEO score: AI crawler access could not be verified
                {visView.state !== 'legacy' &&
                  ` (${visView.simulated.undeterminable} of ${visView.simulated.total} simulated requests undeterminable)`}
                . The citation score stands on its own.
              </p>
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
              <div className="flex items-center gap-2 text-slate-400 text-sm">
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

            {vis.status === 'done' && visView && visView.state !== 'legacy' && (
              <div className="space-y-4">
                {visView.state === 'insufficient' ? (
                  <div>
                    <div className="flex items-end gap-3">
                      <span className="text-4xl font-bold font-mono text-slate-400">—</span>
                      <span className="text-slate-300 text-sm pb-1">Not verified</span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">
                      {visView.simulated.undeterminable} of {visView.simulated.total} simulated crawler requests could not be verified
                      {visView.score !== null &&
                        ` — determinable signals: ${visView.score}/100 (${visView.simulated.determinable} of ${visView.simulated.total})`}
                    </p>
                  </div>
                ) : (
                  <div>
                    <div className="flex items-end gap-3">
                      <span className={`text-4xl font-bold font-mono ${scoreColor(visView.score ?? 0)}`}>
                        {visView.score}
                      </span>
                      <span className="text-slate-400 text-sm pb-1">/ 100</span>
                      <span className={`text-sm pb-1 ${scoreColor(visView.score ?? 0)}`}>
                        {scoreLabel(visView.score ?? 0)}
                      </span>
                    </div>
                    <p className="text-xs font-semibold text-slate-400 mt-1">
                      Based on {visView.simulated.determinable} of {visView.simulated.total} simulated crawler requests
                      {visView.simulated.undeterminable > 0 && ` · ${visView.simulated.undeterminable} undeterminable`}
                    </p>
                  </div>
                )}

                {/* Summary row — simulated requests only */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                  {[
                    { label: 'Content received', val: visView.simulated.accessible, color: 'text-green-400' },
                    { label: 'Partial', val: visView.simulated.partial, color: 'text-yellow-400' },
                    { label: 'Blocked', val: visView.simulated.blocked, color: 'text-red-400' },
                    { label: 'Undeterminable', val: visView.simulated.undeterminable, color: 'text-slate-300' },
                  ].map(({ label, val, color }) => (
                    <div key={label} className="bg-slate-800/50 rounded-lg py-2">
                      <div className={`text-xl font-bold font-mono ${color}`}>{val}</div>
                      <div className="text-xs text-slate-400">{label}</div>
                    </div>
                  ))}
                </div>

                <p className="text-xs text-slate-400">
                  Simulated with crawler user-agents, not verified crawler IP addresses.
                  {visView.robotsTokens.total > 0 &&
                    ` robots.txt permits ${visView.robotsTokens.permitted} of ${visView.robotsTokens.total} AI-use tokens — a permission, not access.`}
                </p>

                {vis.report.llms_txt.present && (
                  <p className="text-xs text-green-400">
                    llms.txt detected
                  </p>
                )}

                {/* Only a block that was actually observed is called a blocker —
                    challenges and refusals are undeterminable, not blocks. */}
                {visBlocked && vis.report.summary.primary_blocker && (
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
                  <span className="text-slate-400 text-sm pb-1">/ 100</span>
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
                        accessibility: 'Accessibility signals (static HTML)',
                      };
                      if (key === 'accessibility') {
                        const a11y = accessibilitySummary(cit.result.categories.accessibility.checks);
                        return (
                          <div key={key} className="flex items-start gap-3">
                            <span className="text-xs text-slate-400 w-32 shrink-0">{labels[key]}</span>
                            <span className="text-xs text-slate-300">
                              {accessibilitySummaryText(a11y)}
                              <span className="block text-slate-400 mt-0.5">{ACCESSIBILITY_DISCLAIMER}</span>
                            </span>
                          </div>
                        );
                      }
                      return (
                        <div key={key} className="flex items-center gap-3">
                          <span className="text-xs text-slate-400 w-32 shrink-0">{labels[key] ?? key}</span>
                          <div className="flex-1 bg-slate-800 rounded-full h-1.5">
                            <div
                              className={`h-1.5 rounded-full ${scoreTone(cat.score).bar}`}
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
                  <p className="text-xs text-slate-400">Full report unavailable (save failed)</p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Summary blurb (once both done) */}
        {cit.status === 'done' && (
          <div className="bg-[#0d1525] border border-slate-800 rounded-2xl p-5">
            <p className="text-xs font-mono text-slate-400 uppercase tracking-wider mb-2">Summary</p>
            <p className="text-sm text-slate-300 leading-relaxed">{cit.result.summary}</p>
          </div>
        )}

        {/* Fix these gaps — carries the domain and both report links. */}
        {fix && (
          <div className="bg-gradient-to-r from-orange-500/10 to-orange-600/5 border border-orange-500/20 rounded-2xl p-6 flex flex-col sm:flex-row items-center gap-4">
            <div className="flex-1 text-center sm:text-left">
              <h2 className="text-lg font-bold">Want help fixing these gaps?</h2>
              <p className="text-sm text-slate-400 mt-1">
                Prequire can scope and implement these fixes for you. Send us this scan and we will reply by email with options.
              </p>
            </div>
            <FixGapsLink href={fix} />
          </div>
        )}

        {/* Emailed-report status for visitors who arrived with an email param. */}
        {cit.status === 'done' && homepageEmail && report && (
          <div role="status" className="bg-[#0d1525] border border-slate-800 rounded-2xl p-5 text-sm text-slate-300">
            {report.status === 'pending' && <p>Preparing your emailed report…</p>}
            {report.status === 'queued' && (
              <p>
                We&apos;re emailing this report to <strong className="text-slate-100">{homepageEmail}</strong>.
                It can take a few minutes to arrive.
              </p>
            )}
            {report.status === 'no_scan' && (
              <p>We couldn&apos;t save this scan, so it can&apos;t be emailed. Your results stay on this page; run the scan again to get it by email.</p>
            )}
            {report.status === 'limited' && (
              <p>We&apos;ve reached today&apos;s limit for emailed reports to this address. Your results stay on this page.</p>
            )}
            {report.status === 'failed' && (
              <>
                <p>We couldn&apos;t send your report request. Your results on this page are unaffected.</p>
                <button
                  type="button"
                  onClick={() => void requestReport()}
                  className="mt-3 border border-slate-500 text-slate-100 hover:bg-slate-800 px-4 py-2 rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-300"
                >
                  Try again
                </button>
              </>
            )}
          </div>
        )}

        {/* Optional email capture — results above stay fully visible either way.
            Visitors who arrived with an email param are handled by the status above
            and don't need a second prompt. */}
        {cit.status === 'done' && !searchParams.get('email') && (
          <EmailReportForm
            url={cit.url}
            score={cit.score}
            surface="overview"
            meta={{
              scan_id: cit.scanId,
              prompt_version: cit.result.scan_meta?.prompt_version ?? null,
              model: cit.result.scan_meta?.model ?? null,
              registry_version:
                vis.status === 'done' ? vis.report.registry_version ?? null : null,
            }}
            utm={{
              utm_source: searchParams.get('utm_source'),
              utm_medium: searchParams.get('utm_medium'),
              utm_campaign: searchParams.get('utm_campaign'),
              utm_content: searchParams.get('utm_content'),
              utm_term: searchParams.get('utm_term'),
            }}
          />
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
