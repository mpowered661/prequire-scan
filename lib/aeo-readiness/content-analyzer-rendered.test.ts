import { describe, it, expect } from 'vitest';
import { analyzeContentDelivery } from './content-analyzer';

// D3 regression: a low text-to-HTML ratio must not by itself be classified as
// client_side_rendered. Heavy page builders (Divi, Elementor) emit enough
// inline CSS/markup to push a server-rendered page below the ratio while its
// content is fully present in the served HTML.

const BULK_CSS = '<style>' + '.x{color:#000}'.repeat(4000) + '</style>';

function heavyBuilderPage(): string {
  return (
    `<!DOCTYPE html><html lang="en"><head>${BULK_CSS}</head>` +
    '<body><main><h1>Acme Plumbing</h1>' +
    '<p>We have served the area for twenty years with licensed plumbers.</p>' +
    '<p>Emergency service is available around the clock, every day.</p>' +
    '<p>Call us for drain cleaning, water heaters, and full repairs.</p>' +
    '</main></body></html>'
  );
}

function emptyShell(): string {
  return `<!DOCTYPE html><html lang="en"><head>${BULK_CSS}</head><body><div id="root"></div></body></html>`;
}

describe('content delivery classification (D3)', () => {
  it('low text ratio WITH rendered content is ok, not client_side_rendered', () => {
    const r = analyzeContentDelivery(heavyBuilderPage());
    expect(r.text_html_ratio).toBeLessThan(0.05);
    expect(r.content_appears_rendered).toBe(true);
    expect(r.status).toBe('ok');
  });

  it('low text ratio WITHOUT rendered content is still client_side_rendered (no regression)', () => {
    const r = analyzeContentDelivery(emptyShell());
    expect(r.text_html_ratio).toBeLessThan(0.05);
    expect(r.content_appears_rendered).toBe(false);
    expect(r.status).toBe('client_side_rendered');
  });
});
