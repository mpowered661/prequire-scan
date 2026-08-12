import { describe, it, expect } from 'vitest';
import { extractA } from './extract-a';
import { extractB } from './extract-b';
import { computeMeasures } from './measures';
import type { ResilienceMeasures } from './types';

// Contradiction precision on commerce structures (red-team finding R2).
//
// A contradiction is reported only when two claims refer to the same factual
// identity and context but assert incompatible values. A page legitimately
// stating several prices — sale vs regular, one per offer, one per variant —
// does not contradict its structured data as long as each declared value is
// corroborated somewhere on the page.

function measureHtml(html: string): ResilienceMeasures {
  return computeMeasures(extractA('https://shop.example/product', html), extractB(html));
}

function productPage(schema: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Widget Pro | Acme Store</title>
<script type="application/ld+json">${schema}</script></head>
<body><main><h1>Widget Pro</h1>${body}</main></body></html>`;
}

describe('detectContradictions — legitimate commerce structures are not contradictions', () => {
  it('sale price beside regular price does not contradict the declared sale price', () => {
    const m = measureHtml(productPage(
      `{"@context":"https://schema.org","@type":"Product","name":"Widget Pro",
        "offers":{"@type":"Offer","price":"79.99","priceCurrency":"USD"}}`,
      `<p>Sale price: $79.99</p><p>Regular price: $99.99</p>`,
    ));
    expect(m.contradictions).toEqual([]);
    expect(m.contradiction_count).toBe(0);
  });

  it('an AggregateOffer lowPrice/highPrice range does not contradict a stated price range', () => {
    const m = measureHtml(productPage(
      `{"@context":"https://schema.org","@type":"Product","name":"Widget Pro",
        "offers":{"@type":"AggregateOffer","lowPrice":"10","highPrice":"45","priceCurrency":"USD"}}`,
      `<p>Price: $10 to $45</p>`,
    ));
    expect(m.contradictions).toEqual([]);
  });

  it('multiple Offer objects each corroborated on the page produce no contradiction', () => {
    const m = measureHtml(productPage(
      `{"@context":"https://schema.org","@type":"Product","name":"Widget Pro",
        "offers":[{"@type":"Offer","price":"29","priceCurrency":"USD"},
                  {"@type":"Offer","price":"290","priceCurrency":"USD"}]}`,
      `<p>Monthly price: $29</p><p>Annual price: $290</p>`,
    ));
    expect(m.contradictions).toEqual([]);
  });

  it('product variants with different prices produce no contradiction', () => {
    const m = measureHtml(productPage(
      `{"@context":"https://schema.org","@type":"ProductGroup","name":"Widget Pro",
        "hasVariant":[
          {"@type":"Product","name":"Small","offers":{"@type":"Offer","price":"19.99"}},
          {"@type":"Product","name":"Large","offers":{"@type":"Offer","price":"24.99"}}]}`,
      `<section><h2>Small</h2><p>Price: $19.99</p></section>
       <section><h2>Large</h2><p>Price: $24.99</p></section>`,
    ));
    expect(m.contradictions).toEqual([]);
  });

  it('the same value in visible HTML and JSON-LD agrees, no contradiction', () => {
    const m = measureHtml(productPage(
      `{"@context":"https://schema.org","@type":"Product","name":"Widget Pro",
        "offers":{"@type":"Offer","price":"49","priceCurrency":"USD"}}`,
      `<p>Price: $49</p>`,
    ));
    expect(m.contradictions).toEqual([]);
  });
});

describe('detectContradictions — genuine conflicts are still reported', () => {
  it('a declared price no page statement corroborates is an important contradiction', () => {
    const m = measureHtml(productPage(
      `{"@context":"https://schema.org","@type":"Product","name":"Widget Pro",
        "offers":{"@type":"Offer","price":"49","priceCurrency":"USD"}}`,
      `<p>Monthly price: $79</p>`,
    ));
    const schemaConflicts = m.contradictions.filter((c) => c.kind === 'schema_body_value');
    expect(schemaConflicts).toHaveLength(1);
    expect(schemaConflicts[0].important).toBe(true);
    expect(schemaConflicts[0].left).toContain('49');
  });

  it('reports one contradiction per declared value even when the page states the wrong value twice', () => {
    const m = measureHtml(productPage(
      `{"@context":"https://schema.org","@type":"Product","name":"Widget Pro",
        "offers":{"@type":"Offer","price":"49","priceCurrency":"USD"}}`,
      `<p>Monthly price: $79</p><p>Current price: $79</p>`,
    ));
    expect(m.contradictions.filter((c) => c.kind === 'schema_body_value')).toHaveLength(1);
  });

  it('a non-commerce label carrying two different values still conflicts', () => {
    const m = measureHtml(productPage(
      `{"@context":"https://schema.org","@type":"Organization","name":"Acme Store"}`,
      `<p>Founded: 1994</p><p>Founded: 1998</p>`,
    ));
    const dup = m.contradictions.filter((c) => c.kind === 'duplicate_label_conflict');
    expect(dup).toHaveLength(1);
    expect(dup[0].left).toContain('1994');
    expect(dup[0].right).toContain('1998');
  });

  it('a price label carrying two values is not treated as a same-fact conflict', () => {
    // Two product cards, both labelled "Price". Without entity identity these
    // are different facts, not one fact with two values.
    const m = measureHtml(productPage(
      `{"@context":"https://schema.org","@type":"Product","name":"Widget Pro"}`,
      `<p>Price: $19.99</p><p>Price: $24.99</p>`,
    ));
    expect(m.contradictions.filter((c) => c.kind === 'duplicate_label_conflict')).toEqual([]);
  });
});
