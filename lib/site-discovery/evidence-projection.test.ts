// Tranche D / Amendment D2 — durable evidence minimization.
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { analyzeContentDelivery, analyzeMetaTags } from '../aeo-readiness/content-analyzer';
import { buildExtractionResilience } from '../extraction-resilience';
import { extractJsonLd } from '../scanPrompt';
import { applyTrancheBDefaults, updateFetchState, type InventoryUrl } from './inventory';
import {
  DurableEvidenceTooLargeError,
  NoRegisteredProjectorError,
  hasProjector,
  projectDurableEvidence,
} from './evidence-projection';
import { analyzePageArtifact, createPageAnalysisSink } from './page-analysis';
import { PAGE_ENGINES, assertPageEngine, type PageEngine } from './page-engines';
import type { FetchedPageArtifact } from './types';
import {
  MAX_DURABLE_OBSERVATION_BYTES,
  MAX_EVIDENCE_LIST_ITEMS,
  MAX_EVIDENCE_STRING_CHARS,
  MAX_EVIDENCE_TOKEN_CHARS,
  MAX_EVIDENCE_URL_CHARS,
} from './versions';

const PROSE_MARKER = 'ZQXPROSE';
const prose = (chars: number) => `${PROSE_MARKER} `.repeat(Math.ceil(chars / 9)).slice(0, chars);

function artifactOf(html: string, url = 'https://example.org/p'): FetchedPageArtifact {
  const bytes = Buffer.from(html);
  return {
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    html,
    contentSha256: createHash('sha256').update(bytes).digest('hex'),
    contentLength: bytes.length,
    fetchedAt: '2026-09-30T00:00:00.000Z',
  };
}

/** Every string anywhere in a value, with its JSON path. */
function allStrings(value: unknown, path = '$', out: { path: string; value: string }[] = []) {
  if (typeof value === 'string') out.push({ path, value });
  else if (Array.isArray(value)) value.forEach((v, i) => allStrings(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) allStrings(v, `${path}.${k}`, out);
  }
  return out;
}

/** Longest run of the marker that survived into durable evidence. */
function longestMarkerRun(value: unknown): number {
  let longest = 0;
  for (const { value: s } of allStrings(value)) {
    if (!s.includes(PROSE_MARKER)) continue;
    longest = Math.max(longest, s.length);
  }
  return longest;
}

const richHtml = `<!doctype html><html lang="en"><head>
<title>About Acme — ${prose(500)}</title>
<meta name="description" content="${prose(3000)}">
<meta name="robots" content="index,follow,${prose(4000)}">
<link rel="canonical" href="https://example.org/${'a'.repeat(4000)}">
<meta property="og:title" content="${prose(2000)}">
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Article',
  headline: prose(400),
  articleBody: prose(40000),
  transcript: prose(30000),
  description: prose(5000),
  sameAs: Array.from({ length: 200 }, (_, i) => `https://example.org/profile/${i}/${prose(200)}`),
  review: Array.from({ length: 50 }, () => ({ '@type': 'Review', reviewBody: prose(2000) })),
  deeply: { nested: { further: { still: { more: { body: prose(20000) } } } } },
})}</script>
</head><body><main>
<h1>${prose(1500)}</h1>
${Array.from({ length: 40 }, (_, i) => `<h2>Heading ${i} ${prose(300)}</h2><p>${prose(2000)}</p>`).join('\n')}
<table><tr><th>Metric</th><td>${prose(1000)}</td></tr></table>
<figure><figcaption>${prose(800)}</figcaption><img src="/i.png" alt="${prose(900)}"></figure>
</main></body></html>`;

function durableFor(html: string) {
  const artifact = artifactOf(html);
  const result = analyzePageArtifact('scan-d2', artifact);
  const byEngine = new Map(result.observations.map(o => [o.engine, o]));
  return { artifact, result, byEngine };
}

describe('D2 — engine results cannot reach durable storage unprojected', () => {
  it('16: every registered page engine has a projector, and assertPageEngine enforces it', () => {
    for (const engine of PAGE_ENGINES) expect(hasProjector(engine.name)).toBe(true);
    expect(() => assertPageEngine({ name: 'rogue' as PageEngine['name'], scope: 'page', networkRequests: 0 }))
      .toThrow('no_registered_projector');
  });

  it('15: an unknown engine cannot bypass projection', () => {
    expect(() => projectDurableEvidence('unknown_engine', { anything: prose(50000) }))
      .toThrow(NoRegisteredProjectorError);
    const rogue = [{ name: 'unknown_engine', engineVersion: 'v', scope: 'page', networkRequests: 0, run: () => ({ body: prose(50000) }) }] as unknown as PageEngine[];
    expect(() => analyzePageArtifact('scan', artifactOf('<html></html>'), rogue)).toThrow('no_registered_projector');
  });

  it('16B: the observation stored is the projection, not the raw engine result', () => {
    const { byEngine } = durableFor(richHtml);
    const er = byEngine.get('extraction_resilience')!;
    expect(er.status).toBe('ok');
    expect(er.observation).not.toHaveProperty('extractA');
    expect(er.observation).toHaveProperty('evidence_projection_version');
  });
});

describe('D2 — source content cannot cross the persistence boundary', () => {
  it('1: raw HTML cannot enter durable observation', () => {
    const { result } = durableFor(richHtml);
    for (const o of result.observations) {
      const json = JSON.stringify(o);
      for (const tag of ['<html', '<body', '<head', '<script', '<h1', '<h2', '<p>', '<table', '<meta', '<!doctype']) {
        expect(json).not.toContain(tag);
      }
    }
  });

  it('2: extractA.text cannot enter durable Extraction Resilience evidence', () => {
    const { artifact, byEngine } = durableFor(richHtml);
    const raw = buildExtractionResilience(artifact.finalUrl, artifact.html) as { extractA: { text: string } };
    expect(raw.extractA.text.length).toBeGreaterThan(10_000); // the engine really does produce it
    const durable = byEngine.get('extraction_resilience')!.observation;
    expect(durable).not.toHaveProperty('extractA');
    expect(JSON.stringify(durable)).not.toContain(raw.extractA.text.slice(0, 200));
  });

  it('3: substantial source prose cannot enter through any other ER field', () => {
    const { byEngine } = durableFor(richHtml);
    const durable = byEngine.get('extraction_resilience')!.observation;
    // No retained string carries a meaningful run of page prose at all.
    expect(longestMarkerRun(durable)).toBe(0);
    for (const { path, value } of allStrings(durable)) {
      expect(value.length, `${path} exceeded the evidence string bound`).toBeLessThanOrEqual(400);
    }
  });

  it('4: a large articleBody is not persisted verbatim', () => {
    const { byEngine } = durableFor(richHtml);
    const durable = byEngine.get('structured_data')!.observation as Record<string, unknown>;
    expect(durable).not.toHaveProperty('blocksText');
    expect(durable).not.toHaveProperty('nodes');
    expect(JSON.stringify(durable)).not.toContain(prose(400));
    // The structural finding survives: the property was seen.
    expect(durable.propertyNames).toContain('articleBody');
  });

  it('5: a large transcript is not persisted verbatim', () => {
    const { byEngine } = durableFor(richHtml);
    const durable = byEngine.get('structured_data')!.observation as Record<string, unknown>;
    expect(JSON.stringify(durable)).not.toContain(prose(400));
    expect(durable.propertyNames).toContain('transcript');
  });

  it('6: arbitrary nested JSON-LD cannot bypass projection', () => {
    const { byEngine } = durableFor(richHtml);
    const durable = byEngine.get('structured_data')!.observation;
    expect(longestMarkerRun(durable)).toBe(0);
    const bytes = Buffer.byteLength(JSON.stringify(durable));
    expect(bytes).toBeLessThanOrEqual(MAX_DURABLE_OBSERVATION_BYTES);
  });

  it('6B: a deeply recursive JSON-LD graph terminates and stays bounded', () => {
    // Self-referential structure — proves the walk is bounded, not recursive-unbounded.
    const cyclic: Record<string, unknown> = { '@type': 'Thing', body: prose(20000) };
    cyclic.self = cyclic;
    const durable = projectDurableEvidence('structured_data', {
      hasSchema: true, hasMalformed: false, blockCount: 1, types: ['Thing'], nodes: [cyclic], blocksText: prose(50000),
    });
    expect(longestMarkerRun(durable)).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(durable))).toBeLessThanOrEqual(MAX_DURABLE_OBSERVATION_BYTES);
  });

  it('7: metadata values are explicitly bounded', () => {
    const { byEngine } = durableFor(richHtml);
    const durable = byEngine.get('meta_tags')!.observation as Record<string, any>;
    // The raw attribute is not retained at all; its token set is.
    expect(durable).not.toHaveProperty('robots_directive');
    expect(durable.robots_directives.length).toBeLessThanOrEqual(MAX_EVIDENCE_LIST_ITEMS);
    for (const token of durable.robots_directives) {
      expect(token.length).toBeLessThanOrEqual(MAX_EVIDENCE_TOKEN_CHARS);
    }
    // The evidence itself survives: the directives were read.
    expect(durable.robots_directives).toContain('index');
    expect(durable.robots_directives).toContain('follow');
    expect(durable.hasRobotsDirective).toBe(true);
    expect(durable.robots_directive_chars).toBeGreaterThan(4000); // the size is recorded honestly
    expect(durable.canonical.length).toBeLessThanOrEqual(MAX_EVIDENCE_URL_CHARS);
    expect(durable.status).toBe('ok');
  });

  it('7B: a canonical href carrying prose is rejected, not bounded', () => {
    const durable = projectDurableEvidence('meta_tags', {
      robots_directive: null,
      ai_blocking_directives: [],
      canonical: `https://example.org/${prose(3000)}`,
      status: 'missing',
    }) as Record<string, any>;
    expect(durable.canonical).toBeNull();
    expect(durable.canonical_rejected).toBe('not_url_shaped');
    expect(longestMarkerRun(durable)).toBe(0);
  });

  it('7C: a well-formed canonical URL is retained as evidence', () => {
    const durable = projectDurableEvidence('meta_tags', {
      robots_directive: 'noindex', ai_blocking_directives: [], canonical: 'https://example.org/about/', status: 'blocked_via_meta',
    }) as Record<string, any>;
    expect(durable.canonical).toBe('https://example.org/about/');
    expect(durable.canonical_rejected).toBeNull();
    expect(durable.robots_directives).toEqual(['noindex']);
  });

  it('adversarial: no engine retains a prose run from any injection site', () => {
    const { result } = durableFor(richHtml);
    for (const o of result.observations) {
      // A robots directive is tokenized, so a comma-free prose blob survives only
      // as one token bounded by MAX_EVIDENCE_TOKEN_CHARS. Nothing larger crosses.
      expect(longestMarkerRun(o.observation), `${o.engine} leaked prose`)
        .toBeLessThanOrEqual(MAX_EVIDENCE_TOKEN_CHARS);
    }
    const nonMetaEngines = result.observations.filter(o => o.engine !== 'meta_tags');
    for (const o of nonMetaEngines) {
      expect(longestMarkerRun(o.observation), `${o.engine} leaked prose`).toBe(0);
    }
  });
});

describe('D2 — evidence remains evidence', () => {
  it('8: content-delivery evidence is semantically complete', () => {
    const { artifact, byEngine } = durableFor(richHtml);
    const raw = analyzeContentDelivery(artifact.html) as unknown as Record<string, unknown>;
    const durable = byEngine.get('content_delivery')!.observation as Record<string, unknown>;
    for (const key of Object.keys(raw)) expect(durable, `missing ${key}`).toHaveProperty(key);
    expect(durable.html_bytes).toBe(raw.html_bytes);
    expect(durable.text_bytes).toBe(raw.text_bytes);
    expect(durable.text_html_ratio).toBe(raw.text_html_ratio);
    expect(durable.js_challenge_detected).toBe(raw.js_challenge_detected);
    expect(durable.content_appears_rendered).toBe(raw.content_appears_rendered);
    expect(durable.status).toBe(raw.status);
  });

  it('9: projected ER evidence still proves the engine result', () => {
    const { artifact, byEngine } = durableFor(richHtml);
    const raw = buildExtractionResilience(artifact.finalUrl, artifact.html) as Record<string, any>;
    const durable = byEngine.get('extraction_resilience')!.observation as Record<string, any>;
    expect(durable.band).toBe(raw.band);
    expect(durable.bandRule).toBe(raw.bandRule);
    expect(durable.measures.contradiction_count).toBe(raw.measures.contradiction_count);
    for (const dim of ['structural_resilience', 'factual_resilience', 'qualifier_resilience']) {
      expect(durable.measures[dim].preserved).toBe(raw.measures[dim].preserved);
      expect(durable.measures[dim].assessed).toBe(raw.measures[dim].assessed);
      expect(durable.measures[dim].ratio).toBe(raw.measures[dim].ratio);
    }
    // Every check id and status is preserved, in order.
    expect(durable.checks.map((c: any) => `${c.id}:${c.status}`))
      .toEqual(raw.checks.map((c: any) => `${c.id}:${c.status}`));
    expect(durable.meta.engine_version).toBe(raw.meta.engine_version);
  });

  it('9B: structured-data structural findings are preserved', () => {
    const { artifact, byEngine } = durableFor(richHtml);
    const raw = extractJsonLd(artifact.html);
    const durable = byEngine.get('structured_data')!.observation as Record<string, any>;
    expect(durable.hasSchema).toBe(raw.hasSchema);
    expect(durable.hasMalformed).toBe(raw.hasMalformed);
    expect(durable.blockCount).toBe(raw.blockCount);
    expect(durable.types).toEqual(raw.types.slice(0, 25));
  });

  it('9C: meta-tags findings are preserved', () => {
    const { artifact, byEngine } = durableFor(richHtml);
    const raw = analyzeMetaTags(artifact.html, 'GPTBot') as Record<string, any>;
    const durable = byEngine.get('meta_tags')!.observation as Record<string, any>;
    expect(durable.status).toBe(raw.status);
    expect(durable.ai_blocking_directives).toEqual(raw.ai_blocking_directives);
    // Every real directive token from the source survives the projection.
    for (const token of String(raw.robots_directive).split(',').map((t: string) => t.trim()).filter(Boolean).slice(0, 3)) {
      if (token.length <= MAX_EVIDENCE_TOKEN_CHARS) expect(durable.robots_directives).toContain(token);
    }
  });

  it('10/11/12: sha, provenance and URL binding are unchanged by projection', () => {
    const { artifact, result } = durableFor(richHtml);
    for (const o of result.observations) {
      expect(o.contentSha256).toBe(artifact.contentSha256);
      expect(o.requestedUrl).toBe(artifact.requestedUrl);
      expect(o.finalUrl).toBe(artifact.finalUrl);
      expect(o.scope).toBe('page');
      const registered = PAGE_ENGINES.find(e => e.name === o.engine)!;
      expect(o.engineVersion).toBe(registered.engineVersion);
    }
  });

  it('13: projection does not change analysis-state honesty', () => {
    const clean = durableFor('<html><head><title>A</title></head><body><main><h1>A</h1><p>Acme grew 42% in 1998 revenue terms.</p></main></body></html>');
    expect(clean.result.analysisState).toBe('complete');
    const engines = PAGE_ENGINES.map(e => e.name === 'meta_tags'
      ? { ...e, run: () => { throw new Error('boom'); } }
      : e) as PageEngine[];
    const partial = analyzePageArtifact('scan', artifactOf(richHtml), engines);
    expect(partial.analysisState).toBe('partial');
  });

  it('14: oversized durable evidence cannot produce successful persistence', () => {
    const projector = () => projectDurableEvidence('structured_data', {
      hasSchema: true,
      hasMalformed: false,
      blockCount: 1,
      types: Array.from({ length: 25 }, (_, i) => `T${i}${'x'.repeat(99)}`),
      nodes: [Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`p${i}${'y'.repeat(95)}`, 1]))],
    });
    expect(projector).toThrow(DurableEvidenceTooLargeError);

    // And through the real path it becomes an explicit failed observation.
    const engines = PAGE_ENGINES.map(e => e.name === 'structured_data'
      ? {
        ...e,
        run: () => ({
          hasSchema: true, hasMalformed: false, blockCount: 1,
          types: Array.from({ length: 25 }, (_, i) => `T${i}${'x'.repeat(99)}`),
          nodes: [Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`p${i}${'y'.repeat(95)}`, 1]))],
        }),
      }
      : e) as PageEngine[];
    const result = analyzePageArtifact('scan', artifactOf('<html><body><h1>a</h1></body></html>'), engines);
    const sd = result.observations.find(o => o.engine === 'structured_data')!;
    expect(sd.status).toBe('failed');
    expect(sd.errorReason).toBe('durable_evidence_too_large');
    expect(sd.observation).toBeNull();
    expect(result.analysisState).toBe('partial');
    expect(result.analysisState).not.toBe('complete');
  });

  it('14B: every durable observation stays within the ceiling', () => {
    for (const html of [richHtml, '<html><body><h1>x</h1></body></html>']) {
      for (const o of durableFor(html).result.observations) {
        expect(Buffer.byteLength(JSON.stringify(o.observation ?? null)))
          .toBeLessThanOrEqual(MAX_DURABLE_OBSERVATION_BYTES);
      }
    }
  });

  it('17: projection performs zero network requests', () => {
    const spy = vi.fn(() => { throw new Error('network from projection'); });
    const original = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      durableFor(richHtml);
    } finally {
      globalThis.fetch = original;
    }
    expect(spy).not.toHaveBeenCalled();
    for (const engine of PAGE_ENGINES) expect(engine.networkRequests).toBe(0);
  });

  it('18: analysis remains non-recursive — one page in, one set of observations out', () => {
    const r = applyTrancheBDefaults({
      urlRaw: 'https://example.org/p', urlNormalized: 'https://example.org/p',
      discoveryMethod: 'sitemap', discoveredFromUrl: null, sitemapSourceUrl: null, linkDepth: 0,
      inScope: true, excludedReason: null, fetchState: 'not_attempted', httpStatus: null,
      analyzed: false, firstSeenAt: '2026-09-30T00:00:00.000Z', selected: true, selectionRank: 1,
    } as InventoryUrl);
    updateFetchState(r, { fetchState: 'fetched', httpStatus: 200 });
    const sink = createPageAnalysisSink('scan', [r]);
    sink.onPage(artifactOf(richHtml));
    expect(sink.observations()).toHaveLength(PAGE_ENGINES.length);
  });
});

describe('D2 — migration 008 constraints hold for real observations', () => {
  it('ok rows carry a stamped object, failed rows carry none and a reason', () => {
    const engines = PAGE_ENGINES.map(e => e.name === 'meta_tags'
      ? { ...e, run: () => { throw new Error('boom'); } }
      : e) as PageEngine[];
    const observations = [
      ...durableFor(richHtml).result.observations,
      ...analyzePageArtifact('scan', artifactOf(richHtml), engines).observations,
    ];
    expect(observations.some(o => o.status === 'failed')).toBe(true);
    for (const o of observations) {
      if (o.status === 'ok') {
        // page_observations_status_observation_agree + _requires_projection
        expect(o.observation).not.toBeNull();
        expect(typeof o.observation).toBe('object');
        expect(Array.isArray(o.observation)).toBe(false);
        expect(o.observation).toHaveProperty('evidence_projection_version');
      } else {
        expect(o.observation).toBeNull();
        expect(o.errorReason).toBeTruthy();
      }
      // page_observations_durable_size_backstop
      expect(Buffer.byteLength(JSON.stringify(o.observation ?? null))).toBeLessThanOrEqual(8192);
    }
  });
});

describe('D2 — measurement', () => {
  it('reports durable vs source for a realistic and a text-heavy page', () => {
    const realistic = `<!doctype html><html lang="en"><head><title>About Us</title>
<meta name="description" content="Who we are.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme"}</script>
</head><body><main><h1>About Acme</h1>
${Array.from({ length: 60 }, (_, i) => `<h2>Section ${i}</h2><p>${'Acme has served customers since 1998 and reports 42% growth. '.repeat(12)}</p>`).join('\n')}
</main></body></html>`;

    for (const [label, html] of [['realistic', realistic], ['text-heavy', richHtml]] as const) {
      const artifact = artifactOf(html);
      const raws: Record<string, number> = {
        extraction_resilience: Buffer.byteLength(JSON.stringify(buildExtractionResilience(artifact.finalUrl, artifact.html))),
        structured_data: Buffer.byteLength(JSON.stringify(extractJsonLd(artifact.html))),
        content_delivery: Buffer.byteLength(JSON.stringify(analyzeContentDelivery(artifact.html))),
        meta_tags: Buffer.byteLength(JSON.stringify(analyzeMetaTags(artifact.html, 'GPTBot'))),
      };
      const result = analyzePageArtifact('scan-m', artifact);
      const lines = [`\n[${label}] source HTML bytes: ${Buffer.byteLength(html)}`];
      let durableTotal = 0;
      let rawTotal = 0;
      for (const o of result.observations) {
        const d = Buffer.byteLength(JSON.stringify(o.observation ?? null));
        durableTotal += d;
        rawTotal += raws[o.engine];
        lines.push(`  ${o.engine.padEnd(22)} raw=${String(raws[o.engine]).padStart(7)}  durable=${String(d).padStart(5)}  status=${o.status}`);
      }
      const strings = allStrings(result.observations.map(o => o.observation));
      const largest = strings.reduce((a, b) => (b.value.length > a.value.length ? b : a), { path: '-', value: '' });
      lines.push(`  raw transient total : ${rawTotal}`);
      lines.push(`  durable total       : ${durableTotal}`);
      lines.push(`  durable/source      : ${(durableTotal / Buffer.byteLength(html) * 100).toFixed(1)}%`);
      lines.push(`  durable/raw         : ${(durableTotal / rawTotal * 100).toFixed(1)}%`);
      lines.push(`  largest text field  : ${largest.path} (${Buffer.byteLength(largest.value)} bytes)`);
      lines.push(`  marker prose run    : ${longestMarkerRun(result.observations.map(o => o.observation))}`);
      // eslint-disable-next-line no-console
      console.log(lines.join('\n'));
      expect(durableTotal).toBeLessThan(Buffer.byteLength(html));
    }
  });
});
