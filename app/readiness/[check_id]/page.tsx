import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getReadinessCheck } from '@/lib/supabase/readinessChecks';
import { CRAWLERS } from '@/lib/aeo-readiness/crawlers';
import type { FixPriority, OverallStatus, CrawlerTier } from '@/lib/aeo-readiness/types';
import { scoreSurface } from '@/lib/aeo-readiness/score-surface';

interface Props {
  params: Promise<{ check_id: string }>;
}

function scoreStyle(score: number): { label: string; textClass: string; borderClass: string } {
  if (score >= 80) return { label: 'Excellent', textClass: 'text-green-400', borderClass: 'border-green-500' };
  if (score >= 60) return { label: 'Good', textClass: 'text-amber-400', borderClass: 'border-amber-500' };
  if (score >= 40) return { label: 'Fair', textClass: 'text-orange-400', borderClass: 'border-orange-500' };
  return { label: 'Poor', textClass: 'text-red-400', borderClass: 'border-red-500' };
}

const STATUS_COLOR: Record<OverallStatus, string> = {
  accessible: 'text-green-400',
  partial: 'text-amber-400',
  blocked: 'text-red-400',
  undeterminable: 'text-slate-400',
};

const PRIORITY_CARD: Record<FixPriority, string> = {
  critical: 'border-red-500/30 bg-red-500/5',
  high: 'border-orange-500/30 bg-orange-500/5',
  medium: 'border-amber-500/30 bg-amber-500/5',
  low: 'border-slate-600/30 bg-slate-500/5',
};

const PRIORITY_BADGE: Record<FixPriority, string> = {
  critical: 'bg-red-500/20 text-red-300',
  high: 'bg-orange-500/20 text-orange-300',
  medium: 'bg-amber-500/20 text-amber-300',
  low: 'bg-slate-500/20 text-slate-400',
};

const TIER_BADGE: Record<CrawlerTier, string> = {
  critical: 'bg-red-500/20 text-red-300',
  important: 'bg-orange-500/20 text-orange-300',
  other: 'bg-slate-600/30 text-slate-400',
  seo: 'bg-blue-500/20 text-blue-300',
};

const tierMap = new Map(CRAWLERS.map((c) => [c.name, c.tier]));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { check_id } = await params;
  const row = await getReadinessCheck(check_id);
  if (!row) return { title: 'Report not found — Prequire' };

  const { label } = scoreStyle(row.score);
  const hostname = (() => { try { return new URL(row.url).hostname; } catch { return row.url; } })();
  const surface = scoreSurface(row.report.summary);

  // Mirrors the on-page score surface: a score never appears without its basis,
  // and a low-coverage report does not headline a score at all.
  const headline =
    surface.state === 'low_coverage'
      ? `AI Crawler Accessibility: ${hostname} — undeterminable for ${surface.undeterminable} of ${surface.total} crawlers`
      : `AI Crawler Accessibility: ${hostname} scores ${row.score}/100`;
  const description =
    surface.state === 'low_coverage'
      ? `${surface.undeterminable} of ${surface.total} AI crawlers could not be verified by UA simulation. Determinable signals: ${row.score}/100 (${surface.determinable} of ${surface.total}).`
      : surface.state === 'reduced'
      ? `${hostname} scored ${row.score}/100 on ${surface.determinable} of ${surface.total} determinable signals (${surface.undeterminable} undeterminable). ${label}.`
      : surface.state === 'clean'
      ? `${hostname} scored ${row.score}/100 for AI crawler accessibility — all ${surface.total} crawlers determinable. ${label}.`
      : `${hostname} scored ${row.score}/100 for AI crawler accessibility. ${label}. ${row.report.summary.accessible}/${row.report.summary.total_crawlers_tested} AI crawlers have full access.`;

  return {
    title: `Crawler Accessibility: ${hostname} — Prequire`,
    description,
    openGraph: {
      title: headline,
      description:
        surface.state === 'low_coverage'
          ? description
          : `${label}. ${row.report.summary.blocked} crawlers blocked, ${row.report.summary.partial} partial. See the full breakdown and fix recommendations.`,
      url: `https://scan.prequire.ai/readiness/${check_id}`,
      siteName: 'Prequire',
      type: 'website',
    },
    twitter: {
      card: 'summary',
      title: headline,
      description: surface.state === 'low_coverage' ? description : `${label}. See the full breakdown and fixes.`,
    },
  };
}

export default async function ReadinessPage({ params }: Props) {
  const { check_id } = await params;
  const row = await getReadinessCheck(check_id);
  if (!row) notFound();

  const { report, score } = row;
  const { label, textClass, borderClass } = scoreStyle(score);
  const surface = scoreSurface(report.summary);
  const hostname = (() => { try { return new URL(row.url).hostname; } catch { return row.url; } })();
  const testedAt = new Date(report.tested_at).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const stackBadges = [
    report.detected_stack.cms && `CMS: ${report.detected_stack.cms}${report.detected_stack.cms_theme ? ` (${report.detected_stack.cms_theme})` : ''}`,
    report.detected_stack.waf && `WAF: ${report.detected_stack.waf}`,
    report.detected_stack.cdn && `CDN: ${report.detected_stack.cdn}`,
    report.detected_stack.web_server && `Server: ${report.detected_stack.web_server}`,
  ].filter(Boolean) as string[];

  return (
    <main className="min-h-screen bg-[#060d18] text-slate-100">
      <section className="max-w-4xl mx-auto px-4 pt-16 pb-16">

        {/* Nav */}
        <div className="mb-6">
          <a href="https://scan.prequire.ai" className="text-xs font-mono text-orange-400 hover:text-orange-300 transition-colors uppercase tracking-wider">
            ← Run your own check
          </a>
        </div>

        {/* Hero — the score never renders without its basis.
            legacy: score + label only (a pre-2026-07 scan measured no coverage — assert none)
            clean/reduced: score headlines with its basis co-equal
            low_coverage: the score is demoted; "Undeterminable" headlines */}
        <div className="bg-[#0d1525] border border-slate-800 rounded-2xl p-8 mb-6 flex flex-col sm:flex-row items-center gap-6">
          {surface.state === 'low_coverage' ? (
            <div className="w-24 h-24 rounded-full border-4 border-slate-600 flex items-center justify-center flex-shrink-0">
              <span className="text-xl font-bold text-slate-400">{surface.undeterminable}/{surface.total}</span>
            </div>
          ) : (
            <div className={`w-24 h-24 rounded-full border-4 ${surface.state === 'reduced' ? 'border-slate-500' : borderClass} flex items-center justify-center flex-shrink-0`}>
              <span className={`text-3xl font-bold ${textClass}`}>{score}</span>
            </div>
          )}
          <div className="flex-1 text-center sm:text-left">
            <p className="text-xs font-mono text-slate-500 mb-1 truncate max-w-xs">{hostname}</p>
            {surface.state === 'low_coverage' ? (
              <>
                <h1 className="text-xl font-bold mb-1">Undeterminable — AI Crawler Accessibility</h1>
                <p className="text-xl font-bold text-slate-400 mb-1">
                  {surface.undeterminable} of {surface.total} crawlers could not be verified by UA simulation
                </p>
                <p className="text-slate-400 text-sm">
                  {surface.determinable === 0
                    ? `0 of ${surface.total} determinable — no score`
                    : `Determinable signals: ${score} · ${surface.determinable} of ${surface.total}`}
                </p>
              </>
            ) : (
              <>
                <h1 className="text-xl font-bold mb-1">{label} — AI Crawler Accessibility</h1>
                {surface.state === 'reduced' && (
                  <p className="text-xl font-bold text-slate-300 mb-1">
                    {surface.determinable} of {surface.total} signals · {surface.undeterminable} undeterminable
                  </p>
                )}
                {surface.state === 'clean' && (
                  <p className="text-slate-400 text-sm">All {surface.total} crawlers determinable</p>
                )}
              </>
            )}
            <p className="text-slate-400 text-sm">
              {report.summary.accessible} of {report.summary.total_crawlers_tested} AI crawlers have full access
            </p>
            <p className="text-xs text-slate-600 mt-2">Tested {testedAt}</p>
          </div>
          <div className="flex-shrink-0">
            <a href="https://prequire.ai/#pricing" className="bg-orange-500 hover:bg-orange-400 text-white font-semibold px-5 py-2.5 rounded-xl transition-colors text-sm">
              Fix these gaps →
            </a>
          </div>
        </div>

        {/* Summary counts — legacy reports keep their original three tiles;
            they measured no undeterminable count, so none is asserted */}
        <div className={`grid ${surface.state === 'legacy' ? 'grid-cols-3' : 'grid-cols-2 sm:grid-cols-4'} gap-4 mb-6`}>
          <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4 text-center">
            <div className="text-2xl font-bold text-green-400">{report.summary.accessible}</div>
            <div className="text-xs text-slate-400 mt-1">Accessible</div>
          </div>
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 text-center">
            <div className="text-2xl font-bold text-amber-400">{report.summary.partial}</div>
            <div className="text-xs text-slate-400 mt-1">Partial Access</div>
          </div>
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-center">
            <div className="text-2xl font-bold text-red-400">{report.summary.blocked}</div>
            <div className="text-xs text-slate-400 mt-1">Blocked</div>
          </div>
          {surface.state !== 'legacy' && (
            <div className="bg-slate-500/10 border border-slate-500/20 rounded-xl p-4 text-center">
              <div className="text-2xl font-bold text-slate-400">{report.summary.undeterminable}</div>
              <div className="text-xs text-slate-400 mt-1">Undeterminable</div>
            </div>
          )}
        </div>

        {surface.state !== 'legacy' && (report.summary.undeterminable ?? 0) > 0 && (
          <p className="text-xs text-slate-500 mb-6">
            Undeterminable: this check simulates crawler user-agents but cannot present
            verified crawler IP addresses. Sites that verify crawler IPs may treat the
            real crawlers differently than these simulations.
          </p>
        )}

        {/* Stack + llms.txt */}
        {(stackBadges.length > 0 || true) && (
          <div className="flex flex-wrap gap-2 items-center mb-8">
            {stackBadges.map((badge) => (
              <span key={badge} className="text-xs font-mono bg-slate-800 border border-slate-700 text-slate-300 px-2.5 py-1 rounded-full">
                {badge}
              </span>
            ))}
            <span className={`text-xs font-mono px-2.5 py-1 rounded-full border ${
              report.llms_txt.present
                ? 'bg-green-500/10 border-green-500/30 text-green-300'
                : 'bg-slate-800 border-slate-700 text-slate-500'
            }`}>
              {report.llms_txt.present ? '✓ llms.txt present' : '✗ No llms.txt'}
            </span>
          </div>
        )}

        {/* Fixes */}
        {report.fixes.length > 0 && (
          <div className="mb-10">
            <h2 className="text-lg font-semibold mb-4">
              Recommended Fixes
              <span className="ml-2 text-sm font-normal text-slate-500">({report.fixes.length})</span>
            </h2>
            <div className="space-y-4">
              {report.fixes.map((fix, i) => (
                <div key={i} className={`border rounded-xl p-5 ${PRIORITY_CARD[fix.priority]}`}>
                  <div className="flex items-start gap-3 mb-2">
                    <span className={`text-xs font-mono uppercase px-2 py-0.5 rounded flex-shrink-0 ${PRIORITY_BADGE[fix.priority]}`}>
                      {fix.priority}
                    </span>
                    <h3 className="font-semibold text-sm leading-snug">{fix.issue}</h3>
                  </div>
                  {(() => {
                    const csrSample = report.crawler_results.find(
                      (r) =>
                        fix.affected_crawlers.includes(r.crawler_name) &&
                        r.tests.content_delivery.status === 'client_side_rendered',
                    );
                    if (!csrSample) return null;
                    const cd = csrSample.tests.content_delivery;
                    const fmtBytes = (b: number) =>
                      b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`;
                    return (
                      <div className="grid grid-cols-3 gap-2 mb-3">
                        <div className="bg-slate-800/60 rounded-lg p-2.5 text-center">
                          <div className="text-base font-bold text-slate-200">{fmtBytes(cd.html_bytes)}</div>
                          <div className="text-xs text-slate-400 mt-0.5">Page size sent</div>
                        </div>
                        <div className="bg-slate-800/60 rounded-lg p-2.5 text-center">
                          <div className="text-base font-bold text-slate-200">{fmtBytes(cd.text_bytes)}</div>
                          <div className="text-xs text-slate-400 mt-0.5">Readable text</div>
                        </div>
                        <div className="bg-amber-500/20 border border-amber-500/30 rounded-lg p-2.5 text-center">
                          <div className="text-base font-bold text-amber-300">
                            {(cd.text_html_ratio * 100).toFixed(1)}%
                          </div>
                          <div className="text-xs text-amber-500/80 mt-0.5">Text ratio</div>
                        </div>
                      </div>
                    );
                  })()}
                  <p className="text-slate-400 text-sm mb-3 leading-relaxed">{fix.fix_summary}</p>
                  <details className="group">
                    <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-300 select-none">
                      Show fix steps ({fix.fix_steps.length})
                    </summary>
                    <ol className="mt-3 space-y-1.5 list-decimal list-inside text-sm text-slate-300 leading-relaxed pl-1">
                      {fix.fix_steps.map((step, j) => (
                        <li key={j}>{step}</li>
                      ))}
                    </ol>
                    {fix.fix_platform && (
                      <p className="mt-2 text-xs text-slate-500">Platform: {fix.fix_platform}</p>
                    )}
                  </details>
                  <p className="text-xs text-slate-600 mt-3">
                    Affects: {fix.affected_crawlers.join(', ')}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Crawler results table */}
        <div className="mb-10">
          <h2 className="text-lg font-semibold mb-4">Crawler-by-Crawler Results</h2>
          <div className="bg-[#0d1525] border border-slate-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="text-left p-3 text-xs text-slate-500 font-mono uppercase tracking-wider">Bot</th>
                  <th className="text-left p-3 text-xs text-slate-500 font-mono uppercase tracking-wider">Tier</th>
                  <th className="text-left p-3 text-xs text-slate-500 font-mono uppercase tracking-wider">Status</th>
                  <th className="text-left p-3 text-xs text-slate-500 font-mono uppercase tracking-wider hidden md:table-cell">Detail</th>
                </tr>
              </thead>
              <tbody>
                {report.crawler_results.map((r, i) => {
                  const tier = tierMap.get(r.crawler_name) ?? 'other';
                  return (
                    <tr key={i} className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/20">
                      <td className="p-3 font-mono text-xs">{r.crawler_name}</td>
                      <td className="p-3">
                        <span className={`text-xs px-2 py-0.5 rounded font-mono capitalize ${TIER_BADGE[tier]}`}>
                          {tier}
                        </span>
                      </td>
                      <td className="p-3">
                        <span className={`text-xs font-semibold capitalize ${STATUS_COLOR[r.overall_status]}`}>
                          {r.overall_status}
                        </span>
                      </td>
                      <td className="p-3 text-slate-500 text-xs hidden md:table-cell max-w-xs truncate">
                        {r.blocker_detail}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* CTA */}
        <div className="bg-gradient-to-r from-orange-500/10 to-orange-600/5 border border-orange-500/20 rounded-2xl p-8 text-center">
          <h2 className="text-xl font-bold mb-2">Ready to get cited by AI engines?</h2>
          <p className="text-slate-400 text-sm mb-5 max-w-md mx-auto">
            Prequire helps you fix crawler access issues and publish atomic pages that ChatGPT, Claude, and Perplexity actually cite.
          </p>
          <a
            href="https://prequire.ai/#pricing"
            className="inline-block bg-orange-500 hover:bg-orange-400 text-white font-semibold px-8 py-3 rounded-xl transition-colors"
          >
            See plans &amp; pricing
          </a>
        </div>

      </section>
    </main>
  );
}
