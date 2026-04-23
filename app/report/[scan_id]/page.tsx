import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getScanResult } from '@/lib/supabase/scanResults';
import { ScoreGauge, CategoryCard } from '@/components/ScanDisplay';
import { CATEGORIES, scoreLabel } from '@/lib/scanUtils';

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
    description: `${hostname} scored ${row.overall_score}/100 for AI engine readiness. ${label}.`,
    openGraph: {
      title: `AEO Report: ${hostname} scores ${row.overall_score}/100`,
      description: `${label}. See the full breakdown of content quality, schema markup, performance, and accessibility.`,
      url: `https://scan.prequire.ai/report/${scan_id}`,
      siteName: 'Prequire',
      type: 'website',
    },
    twitter: {
      card: 'summary',
      title: `AEO Report: ${hostname} scores ${row.overall_score}/100`,
      description: `${label}. See the full AEO breakdown.`,
    },
  };
}

export default async function ReportPage({ params }: Props) {
  const { scan_id } = await params;
  const row = await getScanResult(scan_id);
  if (!row) notFound();

  const result = row.result_json;
  const label = scoreLabel(row.overall_score);
  const scannedAt = new Date(row.created_at).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <main className="min-h-screen bg-[#060d18] text-slate-100">
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
            <p className="text-xs font-mono text-slate-500 mb-1 truncate max-w-xs">{row.url}</p>
            <h1 className="text-2xl font-bold mb-2">{label}</h1>
            <p className="text-slate-400 text-sm leading-relaxed max-w-md">{result.summary}</p>
            <p className="text-xs text-slate-600 mt-3">Scanned {scannedAt}</p>
          </div>
          <div className="sm:ml-auto flex-shrink-0">
            <a
              href="https://prequire.ai/#pricing"
              className="bg-orange-500 hover:bg-orange-400 text-white font-semibold px-5 py-2.5 rounded-xl transition-colors text-sm"
            >
              Fix these gaps →
            </a>
          </div>
        </div>

        {/* Category grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {CATEGORIES.map(({ key, label: catLabel, icon }) => (
            <CategoryCard
              key={key}
              label={catLabel}
              icon={icon}
              data={result.categories[key]}
              isUnlocked={false}
            />
          ))}
        </div>

        {/* Bottom CTA */}
        <div className="mt-10 bg-gradient-to-r from-orange-500/10 to-orange-600/5 border border-orange-500/20 rounded-2xl p-8 text-center">
          <h2 className="text-xl font-bold mb-2">Ready to fix your AEO gaps?</h2>
          <p className="text-slate-400 text-sm mb-5">
            Unlock all recommendations, track your score over time, and publish atomic pages that AI engines cite.
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
