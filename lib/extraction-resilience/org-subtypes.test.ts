import { describe, it, expect } from 'vitest';
import { extractA } from './extract-a';

// D2 regression: organization-name extraction must recognize the full
// schema.org Organization subtype closure, not a hand-kept short list. A
// correctly-marked-up trades or professional business (HVACBusiness, Plumber,
// ProfessionalService, …) previously had its name dropped, so identity fell
// back to the page <title>.

function page(jsonld: string): string {
  return (
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<title>Home | Acme</title>' +
    `<script type="application/ld+json">${jsonld}</script></head>` +
    '<body><main><h1>Welcome</h1><p>We fix things every day.</p></main></body></html>'
  );
}
const ld = (o: Record<string, unknown>) =>
  JSON.stringify({ '@context': 'https://schema.org', ...o });
function orgName(jsonld: string): string | null {
  return extractA('https://acme.example/', page(jsonld)).identity.schemaOrgName;
}

describe('schema.org Organization subtype recognition (D2)', () => {
  it('extracts the name from a LocalBusiness leaf subtype (HVACBusiness)', () => {
    expect(orgName(ld({ '@type': 'HVACBusiness', name: 'Acme Heating and Air' }))).toBe(
      'Acme Heating and Air',
    );
  });

  it('extracts the name from ProfessionalService', () => {
    expect(orgName(ld({ '@type': 'ProfessionalService', name: 'Acme Advisors' }))).toBe(
      'Acme Advisors',
    );
  });

  it('extracts the name from a @type array that contains a subtype', () => {
    expect(
      orgName(ld({ '@type': ['LocalBusiness', 'Plumber'], name: 'Acme Plumbing' })),
    ).toBe('Acme Plumbing');
  });

  it('still extracts a plain Organization (no regression)', () => {
    expect(orgName(ld({ '@type': 'Organization', name: 'Acme Corp' }))).toBe('Acme Corp');
  });

  it('still honors Brand as a business-name signal (no regression)', () => {
    expect(orgName(ld({ '@type': 'Brand', name: 'Acme' }))).toBe('Acme');
  });

  it('does not treat a non-Organization type (WebSite) as a business name', () => {
    expect(orgName(ld({ '@type': 'WebSite', name: 'Acme Site' }))).toBeNull();
  });
});
