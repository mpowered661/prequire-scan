import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractB } from './extract-b';

function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', `${name}.html`), 'utf8');
}

describe('extractB — the deliberately lossy path', () => {
  it('flattens a semantic table into an undifferentiated token run', () => {
    const b = extractB(fixture('matrix-table'));

    // The exact loss the specification describes: header/cell relationships are
    // gone, leaving values in a flat sequence.
    expect(b.text).toContain('Region 2025 2026 North 4.2 5.1 South 9.8 3.3');
  });

  it('tokenizes on whitespace', () => {
    const b = extractB('<p>Retention rate: 94%</p>');

    expect(b.tokens).toEqual(['Retention', 'rate:', '94%']);
    expect(b.length).toBe('Retention rate: 94%'.length);
  });

  it('drops script and style content', () => {
    const b = extractB('<style>.a{color:red}</style><script>var x=1</script><p>kept</p>');

    expect(b.text).toBe('kept');
  });

  it('returns an empty result for empty input', () => {
    const b = extractB('');

    expect(b.text).toBe('');
    expect(b.tokens).toEqual([]);
    expect(b.length).toBe(0);
  });
});
