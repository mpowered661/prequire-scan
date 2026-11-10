import { describe, it, expect } from 'vitest';
import {
  scoreBand, bandLabel, scoreTone, scoreLabel,
  accessibilitySummary, accessibilitySummaryText, ACCESSIBILITY_DISCLAIMER,
} from './scanUtils';
import { fixHref, FIX_REQUEST_EMAIL } from './fixLink';

describe('one set of score labels', () => {
  it.each([[100, 'strong'], [70, 'strong'], [69, 'moderate'], [45, 'moderate'], [44, 'weak'], [0, 'weak']] as const)(
    'score %i → %s everywhere',
    (score, band) => {
      expect(scoreBand(score)).toBe(band);
      const expected = { strong: 'Strong', moderate: 'Moderate', weak: 'Significant gaps' }[band];
      expect(bandLabel(score)).toBe(expected);
      expect(scoreTone(score).text).toBe({ strong: 'text-green-400', moderate: 'text-orange-400', weak: 'text-red-400' }[band]);
      expect(scoreLabel(score).startsWith({ strong: 'Strong', moderate: 'Moderate', weak: 'Significant' }[band])).toBe(true);
    },
  );
});

describe('accessibility honesty', () => {
  const checks = [
    { status: 'pass' }, { status: 'pass' }, { status: 'pass' }, { status: 'pass' },
    { status: 'not_assessable' }, { status: 'not_assessable' },
  ];

  it('counts not-assessed items separately, never as failures', () => {
    expect(accessibilitySummary(checks)).toEqual({ passed: 4, warned: 0, failed: 0, notAssessed: 2, assessed: 4 });
  });

  it('reports counts, not a percentage', () => {
    const text = accessibilitySummaryText(accessibilitySummary(checks));
    expect(text).toBe('4 of 4 static checks passed · 2 not assessed');
    expect(text).not.toMatch(/100|%/);
  });

  it('includes warnings and failures when present', () => {
    const text = accessibilitySummaryText(accessibilitySummary([{ status: 'pass' }, { status: 'warn' }, { status: 'fail' }]));
    expect(text).toBe('1 of 3 static checks passed · 1 need review · 1 failed');
  });

  it('the disclaimer rules out a WCAG or ADA assessment', () => {
    expect(ACCESSIBILITY_DISCLAIMER).toMatch(/not a complete WCAG or ADA/);
    expect(ACCESSIBILITY_DISCLAIMER).toMatch(/Not included in the score/);
  });
});

describe('fix link preserves scan context', () => {
  const scanId = '9b498630-31fa-4ab3-bb1f-29545d6ab014';
  const checkId = 'c2ba6a65-f76f-4c77-bed7-deb28db9f7ed';

  function parse(href: string) {
    const [addr, q] = href.replace(/^mailto:/, '').split('?');
    const p = new URLSearchParams(q);
    return { addr, subject: p.get('subject') ?? '', body: p.get('body') ?? '' };
  }

  it('opens an email to Prequire with the domain and both report links', () => {
    const { addr, subject, body } = parse(fixHref({ url: 'https://prequire.ai/', scanId, checkId }));
    expect(addr).toBe(FIX_REQUEST_EMAIL);
    expect(subject).toBe('Fix the gaps on prequire.ai');
    expect(body).toContain(`https://scan.prequire.ai/report/${scanId}`);
    expect(body).toContain(`https://scan.prequire.ai/readiness/${checkId}`);
  });

  it('accepts a bare domain and works with only one report', () => {
    const { subject, body } = parse(fixHref({ url: 'example.com', checkId }));
    expect(subject).toBe('Fix the gaps on example.com');
    expect(body).not.toContain('/report/');
    expect(body).toContain('/readiness/');
  });

  it('drops anything that is not a report id', () => {
    const { body } = parse(fixHref({ url: 'example.com', scanId: '../evil', checkId: 'x&cc=a@b.c' }));
    expect(body).not.toMatch(/evil|cc=/);
  });

  it('degrades to a generic subject for an unparseable url', () => {
    expect(parse(fixHref({ url: '::::' })).subject).toBe('Fix the gaps on my site');
  });
});
