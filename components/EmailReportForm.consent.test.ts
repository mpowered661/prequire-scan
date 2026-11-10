import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Source pins: the marketing box is separate, optional, and never preselected.
const src = readFileSync(path.join(process.cwd(), 'components/EmailReportForm.tsx'), 'utf8');

describe('EmailReportForm marketing consent', () => {
  it('starts unticked and is never preselected', () => {
    expect(src).toMatch(/useState\(false\)/);
    expect(src).not.toMatch(/defaultChecked/);
    expect(src).not.toMatch(/checked=\{true\}/);
  });
  it('is a labelled native checkbox, separate from the report consent', () => {
    expect(src).toMatch(/id="report-email-updates"\s+type="checkbox"/);
    expect(src).toMatch(/<label htmlFor="report-email-updates"/);
    expect(src).toMatch(/agree to receive this report by email/);
    expect(src).not.toMatch(/this report and occasional Prequire emails/);
  });
  it('sends the v2 consent source and the box state', () => {
    expect(src).toMatch(/consent_source: 'scan_email_report_v2'/);
    expect(src).toMatch(/marketing_opt_in: updatesOptIn/);
  });
});
