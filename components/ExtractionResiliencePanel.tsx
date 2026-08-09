import type {
  ExtractionResilienceResult,
  ResilienceBand,
  ResilienceStatus,
  ResilienceMeasure,
  ResilienceCheck,
} from '@/lib/extraction-resilience/types';

// Presentation rules this component is bound by:
//  - The claim is "does meaning survive machine extraction", never "this is
//    what AI sees". EXTRACT_B is a deliberate stress test, not a model's view.
//  - Status is always carried by text as well as colour (WCAG 2.2 AA 1.4.1).
//  - Numerator and denominator are shown, never a bare percentage, so thin
//    evidence reads as thin evidence.
//  - Anything undeterminable is displayed as undeterminable. No guesses.

const BAND_PRESENTATION: Record<
  ResilienceBand,
  { label: string; text: string; ring: string; dot: string }
> = {
  resilient: {
    label: 'Resilient',
    text: 'text-green-300',
    ring: 'border-green-500/40 bg-green-500/10',
    dot: 'bg-green-400',
  },
  mostly_resilient: {
    label: 'Mostly resilient',
    text: 'text-amber-200',
    ring: 'border-amber-400/40 bg-amber-400/10',
    dot: 'bg-amber-300',
  },
  fragile: {
    label: 'Fragile',
    text: 'text-red-300',
    ring: 'border-red-500/40 bg-red-500/10',
    dot: 'bg-red-400',
  },
  insufficient_evidence: {
    label: 'Insufficient evidence',
    text: 'text-slate-300',
    ring: 'border-slate-600 bg-slate-700/20',
    dot: 'bg-slate-400',
  },
};

const STATUS_PRESENTATION: Record<ResilienceStatus, { label: string; dot: string; text: string }> = {
  pass: { label: 'Pass', dot: 'bg-green-400', text: 'text-green-300' },
  warning: { label: 'Warning', dot: 'bg-amber-300', text: 'text-amber-200' },
  fail: { label: 'Fail', dot: 'bg-red-400', text: 'text-red-300' },
  undeterminable: { label: 'Undeterminable', dot: 'bg-sky-300', text: 'text-sky-200' },
  not_applicable: { label: 'Not applicable', dot: 'bg-slate-500', text: 'text-slate-300' },
};

function MeasureRow({ name, measure }: { name: string; measure: ResilienceMeasure }) {
  const pctWidth = measure.ratio === null ? 0 : Math.round(measure.ratio * 100);

  return (
    <div className="py-3">
      <div className="flex items-baseline justify-between gap-4 mb-1.5">
        <span className="text-sm text-slate-200">{name}</span>
        <span className="text-sm font-mono text-slate-300 whitespace-nowrap">
          {measure.assessed === 0 ? (
            'not applicable'
          ) : (
            <>
              {measure.preserved}
              <span className="text-slate-400"> / {measure.assessed} preserved</span>
            </>
          )}
        </span>
      </div>

      {measure.assessed > 0 && (
        <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full ${
              pctWidth >= 90 ? 'bg-green-500' : pctWidth >= 70 ? 'bg-amber-400' : 'bg-red-500'
            }`}
            style={{ width: `${pctWidth}%` }}
          />
        </div>
      )}

      {measure.undeterminable > 0 && (
        <p className="text-xs text-slate-400 mt-1.5">
          {measure.undeterminable} item(s) undeterminable — excluded from the total rather than
          counted either way.
        </p>
      )}
    </div>
  );
}

function CheckRow({ check }: { check: ResilienceCheck }) {
  const s = STATUS_PRESENTATION[check.status] ?? STATUS_PRESENTATION.not_applicable;

  return (
    <li className="flex items-start gap-3 py-2.5">
      <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${s.dot}`} aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-200">{check.label}</p>
        <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{check.detail}</p>
        {check.evidence.length > 0 && (
          <ul className="mt-1.5 space-y-0.5">
            {check.evidence.map((e, i) => (
              <li key={i} className="text-xs text-slate-400 font-mono break-words">
                — {e}
              </li>
            ))}
          </ul>
        )}
      </div>
      <span className={`text-xs font-mono uppercase whitespace-nowrap ${s.text}`}>{s.label}</span>
    </li>
  );
}

export function ExtractionResiliencePanel({
  result,
}: {
  result: ExtractionResilienceResult | null | undefined;
}) {
  if (!result) return null;

  const band = BAND_PRESENTATION[result.band] ?? BAND_PRESENTATION.insufficient_evidence;
  const a = result.extractA;
  const m = result.measures;

  const undeterminableChecks = result.checks.filter((c) => c.status === 'undeterminable');

  return (
    <section
      aria-labelledby="extraction-resilience-heading"
      className="bg-[#0d1525] border border-slate-800 rounded-2xl p-6 sm:p-8"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
        <h2 id="extraction-resilience-heading" className="text-lg font-semibold text-slate-100">
          Extraction Resilience
        </h2>
        <span
          className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-mono uppercase tracking-wider ${band.ring} ${band.text}`}
        >
          <span className={`w-2 h-2 rounded-full ${band.dot}`} aria-hidden="true" />
          {band.label}
        </span>
      </div>

      <p className="text-sm text-slate-300 leading-relaxed mb-1">{result.bandReason}</p>
      <p className="text-xs text-slate-400 mb-2">
        Triggered by rule <code className="font-mono">{result.bandRule}</code>.
      </p>
      <p className="text-xs text-slate-400 leading-relaxed mb-6">
        We read this page twice: once keeping its structure (headings, tables, labels, units,
        footnotes) and once through a deliberately lossy text-only pass. The difference shows
        whether the page&apos;s meaning depends on presentation that an extractor may discard. A
        large difference means the page is vulnerable to lossy extraction — it does not by itself
        mean the page is badly built.
      </p>

      <h3 className="text-xs font-mono text-orange-400 uppercase tracking-wider mb-1">
        What survived
      </h3>
      <div className="divide-y divide-slate-800/60 mb-6">
        <MeasureRow name="Structural relationships" measure={m.structural_resilience} />
        <MeasureRow name="Facts that keep their full attribution" measure={m.factual_resilience} />
        <MeasureRow
          name="Claim qualifiers (hedges, disclaimers, footnotes)"
          measure={m.qualifier_resilience}
        />
        <div className="flex items-baseline justify-between gap-4 py-3">
          <span className="text-sm text-slate-200">Contradictions found</span>
          <span
            className={`text-sm font-mono ${
              m.contradiction_count > 0 ? 'text-red-300' : 'text-slate-300'
            }`}
          >
            {m.contradiction_count}
          </span>
        </div>
      </div>

      <h3 className="text-xs font-mono text-orange-400 uppercase tracking-wider mb-1">Checks</h3>
      <ul className="divide-y divide-slate-800/60 mb-6">
        {result.checks.map((c) => (
          <CheckRow key={c.id} check={c} />
        ))}
      </ul>

      {undeterminableChecks.length > 0 && (
        <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-4 mb-6">
          <h3 className="text-sm font-semibold text-sky-200 mb-1">Not assessed</h3>
          <p className="text-xs text-slate-300 leading-relaxed">
            Some questions could not be answered from the page markup. They are reported as
            undeterminable and excluded from every total — reading text inside images requires
            visual analysis, which this scan does not perform.
          </p>
        </div>
      )}

      <details className="group border-t border-slate-800 pt-4">
        <summary className="cursor-pointer text-sm text-orange-400 hover:text-orange-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0d1525] rounded">
          Inspect the structural extraction
        </summary>

        <div className="mt-4 space-y-5">
          <div>
            <h4 className="text-xs font-mono text-slate-400 uppercase tracking-wider mb-2">
              Page identity
            </h4>
            <dl className="grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-slate-400">Entity</dt>
              <dd className="text-slate-200 break-words">
                {a.identity.resolvedEntity ?? 'Not identifiable from markup'}
                {a.identity.resolvedEntity && (
                  <span className="text-slate-400"> (from {a.identity.entitySource.replace(/_/g, ' ')})</span>
                )}
              </dd>

              <dt className="text-slate-400">Topic</dt>
              <dd className="text-slate-200 break-words">
                {a.identity.pageTopic ?? 'Not identifiable from markup'}
                {a.identity.pageTopic && (
                  <span className="text-slate-400"> (from {a.identity.topicSource.replace(/_/g, ' ')})</span>
                )}
              </dd>

              <dt className="text-slate-400">Canonical</dt>
              <dd className="text-slate-200 break-all">{a.identity.canonicalUrl ?? 'None declared'}</dd>

              <dt className="text-slate-400">Schema types</dt>
              <dd className="text-slate-200 break-words">
                {a.schema.types.length > 0 ? a.schema.types.join(', ') : 'None detected'}
              </dd>
            </dl>
          </div>

          {a.bindings.length > 0 && (
            <div>
              <h4 className="text-xs font-mono text-slate-400 uppercase tracking-wider mb-2">
                Values and what they refer to
              </h4>
              <ul className="space-y-1.5">
                {a.bindings.slice(0, 12).map((b) => (
                  <li key={b.id} className="text-sm text-slate-200 break-words">
                    <span className="text-slate-400">{b.label ?? 'unlabeled'}:</span>{' '}
                    <span className="font-mono">{b.value}</span>
                    {b.dimensions.length > 0 && (
                      <span className="text-slate-400">
                        {' '}
                        ({b.dimensions.map((d) => d.label).join(', ')})
                      </span>
                    )}
                    {b.units.length > 0 && (
                      <span className="text-slate-400">
                        {' '}
                        {b.units.map((u) => u.text).join(' ')}
                      </span>
                    )}
                    {b.qualifiers.length > 0 && (
                      <span className="text-slate-400">
                        {' '}
                        [{b.qualifiers.map((q) => `${q.kind}: ${q.text}`).join(', ')}]
                      </span>
                    )}
                    {b.dimensionUnresolved && (
                      <span className="text-sky-200"> (column attribution undeterminable)</span>
                    )}
                  </li>
                ))}
              </ul>
              {a.bindings.length > 12 && (
                <p className="text-xs text-slate-400 mt-2">
                  Showing 12 of {a.bindings.length} values.
                </p>
              )}
            </div>
          )}

          {a.tables.length > 0 && (
            <div>
              <h4 className="text-xs font-mono text-slate-400 uppercase tracking-wider mb-2">
                Tables
              </h4>
              <ul className="space-y-1">
                {a.tables.map((t) => (
                  <li key={t.index} className="text-sm text-slate-200">
                    Table {t.index + 1}:{' '}
                    {t.isKeyValue ? 'key/value' : 'matrix'} — {t.rowHeaders.length} row header(s),{' '}
                    {t.columnHeaders.length} column header(s)
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <h4 className="text-xs font-mono text-slate-400 uppercase tracking-wider mb-2">
              Machine-readable assets
            </h4>
            <p className="text-sm text-slate-200">
              {a.assets.images.total} image(s) — {a.assets.images.withAlt} described,{' '}
              {a.assets.images.decorative} decorative, {a.assets.images.withoutAlt} with no alt
              attribute. {a.assets.tables} table(s), {a.assets.svg} SVG, {a.assets.canvas} canvas,{' '}
              {a.assets.iframes} iframe(s), {a.assets.jsonLdBlocks} JSON-LD block(s).
            </p>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed">
            Engine {result.meta.engine_version}. Structural extraction is DOM-aware; the comparison
            pass is the scanner&apos;s existing flattened text extraction. Visual analysis is not
            performed in this version.
          </p>
        </div>
      </details>
    </section>
  );
}
