import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getScanResult } from '@/lib/supabase/scanResults';
import { ScoreGauge, CategoryCard } from '@/components/ScanDisplay';
import { CATEGORIES, scoreLabel } from '@/lib/scanUtils';
import { ExtractionResiliencePanel } from '@/components/ExtractionResiliencePanel';
import { FixGapsLink } from '@/components/FixGapsLink';
import { fixHref } from '@/lib/fixLink';
import { parseExtractionResilience } from '@/lib/extraction-resilience/guard';

interface Props {
  params: Promise<{ scan_id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { scan_id } = await params;
  const row = await getScanResult(scan_id);
  if (!row) {
    return { title: 'Report not found — Prequire' };
  }
  const label = scoreLabel(row.overall_score);
  const hostname = new URL(row.url).hostname;
  return {
    title: `AEO Report: ${hostname} — Prequire`,
    description: `${hostname} scored ${row.overall_score}/100 for citation readiness. ${label}.`,
    openGraph: {
      title: `AEO Report: ${hostname} — citation readiness ${row.overall_score}/100`,
      description: `${label}. See the full breakdown of content quality, schema markup, performance, and static accessibility signals.`,
      url: `https://scan.prequire.ai/report/${scan_id}`,
      siteName: 'Prequire',
      type: 'website',
    },
    twitter: {
      card: 'summary',
      title: `AEO Report: ${hostname} — citation readiness ${row.overall_score}/100`,
      description: `${label}. See the full AEO breakdown.`,
    },
  };
}

export default async function ReportPage({ params }: Props) {
  const { scan_id } = await params;
  const row = await getScanResult(scan_id);
  if (!row) notFound();

  const result = row.result_json;
  const resilience = parseExtractionResilience(result?.extraction_resilience);
  const label = scoreLabel(row.overall_score);
  const fix = fixHref({ url: row.url, scanId: scan_id });
  const scannedAt = new Date(row.created_at).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <main id="main-content" className="min-h-screen bg-[#060d18] text-slate-100">
      {/* Header */}
      <section className="max-w-5xl mx-auto px-4 pt-16 pb-10">
        <div className="flex items-center gap-2 mb-6">
          <a href="https://scan.prequire.ai" className="text-xs font-mono text-orange-400 hover:text-orange-300 transition-colors uppercase tracking-wider">
            ← Run your own scan
          </a>
        </div>

        <div className="bg-[#0d1525] border border-slate-800 rounded-2xl p-8 mb-8 flex flex-col sm:flex-row items-center gap-8">
          <ScoreGauge score={result.overallScore} />
          <div className="text-center sm:text-left flex-1">
            <p className="text-xs font-mono text-slate-400 mb-1 truncate max-w-xs">{row.url}</p>
            <h1 className="text-2xl font-bold mb-2">{label}</h1>
            <p className="text-slate-400 text-sm leading-relaxed max-w-md">{result.summary}</p>
            <p className="text-xs text-slate-400 mt-3">Scanned {scannedAt}</p>
          </div>
          <div className="sm:ml-auto flex-shrink-0">
            <FixGapsLink href={fix} />
          </div>
        </div>

        {/* Category grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {CATEGORIES.map(({ key, label: catLabel, icon }) => (
            <CategoryCard
              key={key}
              categoryKey={key}
              label={catLabel}
              icon={icon}
              data={result.categories[key]}
              isUnlocked={false}
              fixHref={fix}
            />
          ))}
        </div>

        {/* Extraction Resilience — parsed defensively: rows stored before this
            feature existed have no such key, and a malformed blob must render
            nothing rather than a confident verdict. */}
        {resilience && (
          <div className="mt-6">
            <ExtractionResiliencePanel result={resilience} />
          </div>
        )}

        {/* Bottom CTA */}
        <div className="mt-10 bg-gradient-to-r from-orange-500/10 to-orange-600/5 border border-orange-500/20 rounded-2xl p-8 text-center">
          <h2 className="text-xl font-bold mb-2">Want help fixing these gaps?</h2>
          <p className="text-slate-400 text-sm mb-5">
            Prequire can scope and implement these fixes for you. Send us this report and we will reply by email with options.
          </p>
          <FixGapsLink href={fix} label="Ask Prequire to fix these gaps" size="lg" />
        </div>
      </section>
    </main>
  );
}
