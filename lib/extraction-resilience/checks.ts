import type {
  StructuredExtraction,
  ResilienceMeasures,
  ResilienceCheck,
  ResilienceStatus,
  ResilienceMeasure,
} from './types';

// The deterministic check set. Every status is derived from EXTRACT_A and the
// A/B comparison — no model participates, and nothing here is inferred from
// pixels. Where a question cannot be answered from the available evidence the
// answer is `undeterminable`, which is surfaced and excluded from denominators
// rather than being quietly treated as a pass.

const EVIDENCE_CAP = 6;

function ratioStatus(
  m: ResilienceMeasure,
  passAt: number,
  warnAt: number,
): ResilienceStatus {
  if (m.assessed === 0) return 'not_applicable';
  const r = m.ratio!;
  if (r >= passAt) return 'pass';
  if (r >= warnAt) return 'warning';
  return 'fail';
}

function check(
  id: string,
  label: string,
  status: ResilienceStatus,
  detail: string,
  evidence: string[] = [],
): ResilienceCheck {
  return { id, label, status, detail, evidence: evidence.slice(0, EVIDENCE_CAP) };
}

const CHART_HINTS = [
  'chart', 'graph', 'infographic', 'diagram', 'figure', 'plot',
  'stats', 'statistics', 'dashboard', 'visualization', 'viz', 'table',
];

export function runChecks(
  a: StructuredExtraction,
  m: ResilienceMeasures,
): ResilienceCheck[] {
  const checks: ResilienceCheck[] = [];

  // 1. Table semantics — does the markup express header relationships at all?
  if (a.tables.length === 0) {
    checks.push(
      check('table_semantics', 'Table semantics', 'not_applicable', 'This page has no tables.'),
    );
  } else {
    const headerless = a.tables.filter(
      (t) => t.columnHeaders.length === 0 && t.rowHeaders.length === 0,
    );
    const status: ResilienceStatus =
      headerless.length === 0 ? 'pass' : headerless.length === a.tables.length ? 'fail' : 'warning';
    checks.push(
      check(
        'table_semantics',
        'Table semantics',
        status,
        headerless.length === 0
          ? `All ${a.tables.length} table(s) carry header cells, so each value is bound to a row and column.`
          : `${headerless.length} of ${a.tables.length} table(s) have no header cells, leaving their values unbound.`,
        headerless.map((t) => `table ${t.index + 1}: no row or column headers`),
      ),
    );
  }

  // 2. Number/label association — does each value say what it measures?
  const labeled = a.bindings.filter((b) => b.label !== null).length;
  if (a.bindings.length === 0) {
    checks.push(
      check(
        'number_label_association',
        'Values carry labels',
        'not_applicable',
        'No factual values were found in the page text.',
      ),
    );
  } else {
    const ratio = labeled / a.bindings.length;
    const status: ResilienceStatus = ratio >= 0.8 ? 'pass' : ratio >= 0.5 ? 'warning' : 'fail';
    checks.push(
      check(
        'number_label_association',
        'Values carry labels',
        status,
        `${labeled} of ${a.bindings.length} values state what they refer to.`,
        a.bindings.filter((b) => !b.label).map((b) => `${b.value} has no label in the markup`),
      ),
    );
  }

  // 3. Unit preservation — of values that have a unit, does it stay attached?
  // Units are read from `binding.units`, which never contains table headers:
  // a column header is attribution and is measured by factual resilience.
  let unitTotal = 0;
  let unitKept = 0;
  const unitLost: string[] = [];
  for (const b of a.bindings) {
    for (const u of b.units) {
      unitTotal += 1;
      if (u.source === 'unit_suffix') unitKept += 1;
      else unitLost.push(`${b.label ?? b.value}: "${u.text}" is declared in the ${u.source.replace('_', ' ')}`);
    }
  }
  if (unitTotal === 0) {
    checks.push(
      check('unit_preservation', 'Units stay with their numbers', 'not_applicable',
        'No units, currencies, or scales are attached to values on this page.'),
    );
  } else {
    const r = unitKept / unitTotal;
    checks.push(
      check(
        'unit_preservation',
        'Units stay with their numbers',
        r >= 0.9 ? 'pass' : r >= 0.5 ? 'warning' : 'fail',
        `${unitKept} of ${unitTotal} units stay attached to their value under lossy extraction. ` +
          'A unit declared in a caption separates from the number it belongs to.',
        unitLost,
      ),
    );
  }

  // 4. Qualifier preservation — the full picture including periods and scopes.
  checks.push(
    check(
      'qualifier_preservation',
      'Claim qualifiers survive extraction',
      ratioStatus(m.qualifier_resilience, 0.9, 0.5),
      m.qualifier_resilience.assessed === 0
        ? 'No claim qualifiers (hedging language, disclaimers, restrictions, footnotes) are ' +
          'attached to values on this page, so there is nothing of this kind to lose.'
        : `${m.qualifier_resilience.preserved} of ${m.qualifier_resilience.assessed} claim qualifiers ` +
          '(hedging language, disclaimers, restrictions, footnotes) remain attributable after flattening.',
      m.qualifier_resilience.lost,
    ),
  );

  // 5. Footnote reachability — does a reference resolve to its text?
  if (a.footnotes.length === 0) {
    checks.push(
      check('footnote_reachability', 'Footnotes resolve', 'not_applicable',
        'This page has no footnote references.'),
    );
  } else {
    const dangling = a.footnotes.filter((f) => !f.reachable);
    checks.push(
      check(
        'footnote_reachability',
        'Footnotes resolve',
        dangling.length === 0 ? 'pass' : 'fail',
        dangling.length === 0
          ? `All ${a.footnotes.length} footnote reference(s) resolve to text in the document. Note that ` +
            'the reference itself does not survive flattening — see qualifier preservation.'
          : `${dangling.length} of ${a.footnotes.length} footnote reference(s) point to an element that does not exist.`,
        dangling.map((f) => `marker "${f.marker}" → #${f.targetId} not found`),
      ),
    );
  }

  // 6. Schema/body contradiction.
  const schemaConflicts = m.contradictions.filter((c) => c.kind === 'schema_body_value');
  if (a.schema.blockCount === 0) {
    checks.push(
      check('schema_body_contradiction', 'Structured data agrees with the page', 'not_applicable',
        'This page carries no structured data.'),
    );
  } else {
    checks.push(
      check(
        'schema_body_contradiction',
        'Structured data agrees with the page',
        schemaConflicts.length === 0 ? 'pass' : 'fail',
        schemaConflicts.length === 0
          ? 'Values declared in structured data match the values stated in the page text.'
          : `${schemaConflicts.length} value(s) are declared one way in structured data and stated another way on the page.`,
        schemaConflicts.map((c) => c.detail),
      ),
    );
  }

  // 7. Entity consistency.
  const entityConflicts = m.contradictions.filter((c) => c.kind === 'entity_name');
  const hasEntitySignal =
    !!a.identity.schemaOrgName || !!a.identity.ogSiteName || !!a.identity.titleSuffix;
  if (!hasEntitySignal) {
    checks.push(
      check(
        'entity_consistency',
        'The page names its entity consistently',
        'undeterminable',
        'Nothing on this page names the organization it belongs to, so consistency cannot be assessed.',
      ),
    );
  } else {
    checks.push(
      check(
        'entity_consistency',
        'The page names its entity consistently',
        entityConflicts.length === 0 ? 'pass' : 'fail',
        entityConflicts.length === 0
          ? `The page identifies "${a.identity.resolvedEntity}" consistently across its identity signals.`
          : entityConflicts[0].detail,
        entityConflicts.map((c) => c.detail),
      ),
    );
  }

  // 7b. Fact attribution — the whole tuple, not just the number.
  checks.push(
    check(
      'fact_attribution',
      'Facts keep their full attribution',
      ratioStatus(m.factual_resilience, 0.9, 0.5),
      m.factual_resilience.assessed === 0
        ? 'No factual values were found in the page text.'
        : `${m.factual_resilience.preserved} of ${m.factual_resilience.assessed} facts survive with ` +
          'their label and every dimension that identifies them. A table value that keeps its row ' +
          'label but loses its column header is counted as lost.',
      m.factual_resilience.lost,
    ),
  );

  // 8. Extraction delta — how much structure the lossy path destroys.
  checks.push(
    check(
      'extraction_delta',
      'Structure survives extraction',
      ratioStatus(m.structural_resilience, 0.8, 0.5),
      m.structural_resilience.assessed === 0
        ? 'No structural relationships were found to compare.'
        : `${m.structural_resilience.preserved} of ${m.structural_resilience.assessed} structural ` +
          'relationships survive the flattened extraction path.',
      m.structural_resilience.lost,
    ),
  );

  // 9. Visual facts — deferred to Increment 2, never guessed.
  const chartLike = a.assets.imageCandidates.filter((img) => {
    const haystack = `${img.src} ${img.alt ?? ''}`.toLowerCase();
    return CHART_HINTS.some((h) => haystack.includes(h));
  });
  const visualCount = chartLike.length + a.assets.canvas;
  checks.push(
    check(
      'visual_fact_reachability',
      'Facts held in images',
      visualCount === 0 ? 'not_applicable' : 'undeterminable',
      visualCount === 0
        ? 'No charts, diagrams, or canvas elements that might carry facts were found.'
        : `${visualCount} image or canvas element(s) may carry factual content. Reading them requires ` +
          'vision, which this increment does not perform — this is reported as undeterminable rather ' +
          'than assumed either way.',
      chartLike.map((img) => img.src || '(inline image)'),
    ),
  );

  return checks;
}
