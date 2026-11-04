import { describe, it, expect } from 'vitest';
import { extractA } from './extract-a';
import { extractB } from './extract-b';
import { computeMeasures } from './measures';
import { runChecks } from './checks';
import type { ResilienceStatus } from './types';

// D4 regression: "Structured data agrees with the page" must not pass when the
// tool compared nothing. The check only cross-references price-like values the
// page also states; schema that declares only name/address/hours gives it
// nothing comparable, so the honest verdict is undeterminable — not pass.

function page(schema: string | null, body: string): string {
  const s = schema ? `<script type="application/ld+json">${schema}</script>` : '';
  return (
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Acme Store</title>' +
    `${s}</head><body><main><h1>Acme</h1>${body}</main></body></html>`
  );
}
const ld = (o: Record<string, unknown>) =>
  JSON.stringify({ '@context': 'https://schema.org', ...o });

function agreementStatus(html: string): ResilienceStatus | undefined {
  const a = extractA('https://acme.example/', html);
  return runChecks(a, computeMeasures(a, extractB(html))).find(
    (c) => c.id === 'schema_body_contradiction',
  )?.status;
}

describe('schema_body_contradiction honesty (D4)', () => {
  it('is undeterminable when structured data declares nothing cross-checkable', () => {
    const schema = ld({
      '@type': 'LocalBusiness',
      name: 'Acme Plumbing',
      address: '100 Main St, Springfield',
    });
    expect(agreementStatus(page(schema, '<p>Visit us at 100 Main St, Springfield.</p>'))).toBe(
      'undeterminable',
    );
  });

  it('passes when a declared price matches the page', () => {
    const schema = ld({
      '@type': 'Product',
      name: 'Widget',
      offers: { '@type': 'Offer', price: '49' },
    });
    expect(agreementStatus(page(schema, '<p>Price: $49</p>'))).toBe('pass');
  });

  it('fails when a declared price contradicts the page', () => {
    const schema = ld({
      '@type': 'Product',
      name: 'Widget',
      offers: { '@type': 'Offer', price: '49' },
    });
    expect(agreementStatus(page(schema, '<p>Price: $79</p>'))).toBe('fail');
  });

  it('is not_applicable when the page has no structured data', () => {
    expect(agreementStatus(page(null, '<p>Price: $49</p>'))).toBe('not_applicable');
  });
});
