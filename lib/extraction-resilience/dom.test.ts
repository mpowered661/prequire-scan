import { describe, it, expect } from 'vitest';
import { parseHtml, textOf, findAll, findFirst, attr, spanAttr } from './dom';

describe('parseHtml — tree structure', () => {
  it('nests elements as parent and child', () => {
    const root = parseHtml('<div><p>hello</p></div>');
    const div = findFirst(root, 'div')!;

    expect(div.tag).toBe('div');
    expect(div.children).toHaveLength(1);
    expect((div.children[0] as { tag: string }).tag).toBe('p');
    expect(textOf(div)).toBe('hello');
  });

  it('lowercases tag names', () => {
    const root = parseHtml('<DIV><P>x</P></DIV>');
    expect(findFirst(root, 'div')).not.toBeNull();
    expect(findFirst(root, 'p')).not.toBeNull();
  });

  it('returns an empty document for empty input', () => {
    // parse5 inserts the required html/head/body scaffolding, which is correct
    // HTML5 behaviour — what matters is that there is no content.
    const root = parseHtml('');
    expect(textOf(root).trim()).toBe('');
    expect(findAll(root, 'p')).toEqual([]);
  });

  it('ignores doctype and comments', () => {
    const root = parseHtml('<!DOCTYPE html><!-- note --><p>kept</p>');
    expect(textOf(root)).toBe('kept');
    expect(findAll(root, 'p')).toHaveLength(1);
  });
});

describe('parseHtml — attributes', () => {
  it('reads double-quoted, single-quoted, unquoted, and boolean attributes', () => {
    const root = parseHtml(
      `<input type="text" name='user' size=20 required>`,
    );
    const input = findFirst(root, 'input')!;

    expect(attr(input, 'type')).toBe('text');
    expect(attr(input, 'name')).toBe('user');
    expect(attr(input, 'size')).toBe('20');
    expect(attr(input, 'required')).toBe('');
  });

  it('is case-insensitive on attribute names and returns null when absent', () => {
    const root = parseHtml('<img SRC="/a.png">');
    const img = findFirst(root, 'img')!;

    expect(attr(img, 'src')).toBe('/a.png');
    expect(attr(img, 'alt')).toBeNull();
  });

  it('decodes entities in attribute values', () => {
    const root = parseHtml('<a title="Tom &amp; Jerry">x</a>');
    expect(attr(findFirst(root, 'a')!, 'title')).toBe('Tom & Jerry');
  });
});

describe('parseHtml — text and entities', () => {
  it('decodes named and numeric entities', () => {
    const root = parseHtml('<p>a &amp; b &lt;c&gt; &#39;d&#39; &nbsp; &mdash;</p>');
    const text = textOf(findFirst(root, 'p')!);

    expect(text).toContain('a & b');
    expect(text).toContain('<c>');
    expect(text).toContain("'d'");
    expect(text).toContain('—');
  });

  it('joins text across inline children', () => {
    const root = parseHtml('<p>Retention rate: <strong>94%</strong> overall</p>');
    expect(textOf(findFirst(root, 'p')!)).toBe('Retention rate: 94% overall');
  });
});

describe('parseHtml — void and self-closing elements', () => {
  it('does not let a void element swallow following siblings', () => {
    const root = parseHtml('<p>before<img src="/a.png">after</p>');
    const p = findFirst(root, 'p')!;

    expect(findAll(p, 'img')).toHaveLength(1);
    expect(textOf(p)).toBe('beforeafter');
  });

  it('handles XML-style self-closing syntax', () => {
    const root = parseHtml('<div><br/><hr /><span>x</span></div>');
    const div = findFirst(root, 'div')!;

    expect(div.children.filter((c) => c.type === 'element')).toHaveLength(3);
    expect(textOf(div)).toBe('x');
  });
});

describe('parseHtml — raw text elements', () => {
  it('does not parse tags inside script content', () => {
    const root = parseHtml('<div><script>var a = "<p>not real</p>";</script><p>real</p></div>');

    // Exactly one <p> — the one outside the script.
    expect(findAll(root, 'p')).toHaveLength(1);
    expect(textOf(findFirst(root, 'p')!)).toBe('real');
  });

  it('excludes script and style content from text extraction', () => {
    const root = parseHtml('<div><style>.a{color:red}</style><script>x=1</script>visible</div>');
    expect(textOf(findFirst(root, 'div')!)).toBe('visible');
  });

  it('still exposes the script element and its raw content for JSON-LD callers', () => {
    const root = parseHtml('<script type="application/ld+json">{"a":1}</script>');
    const script = findFirst(root, 'script')!;

    expect(attr(script, 'type')).toBe('application/ld+json');
    expect((script.children[0] as { text: string }).text).toBe('{"a":1}');
  });
});

describe('parseHtml — implied end tags', () => {
  it('closes an open <p> when a block element starts', () => {
    const root = parseHtml('<div><p>one<p>two<div>three</div></div>');
    const ps = findAll(root, 'p');

    expect(ps).toHaveLength(2);
    expect(textOf(ps[0])).toBe('one');
    expect(textOf(ps[1])).toBe('two');
    // "three" belongs to the inner div, not to <p>two</p>
    expect(textOf(ps[1])).not.toContain('three');
  });

  it('closes <li> at the next <li>', () => {
    const root = parseHtml('<ul><li>a<li>b<li>c</ul>');
    const lis = findAll(root, 'li');

    expect(lis.map((li) => textOf(li))).toEqual(['a', 'b', 'c']);
  });

  it('closes <td> and <tr> implicitly', () => {
    const root = parseHtml('<table><tr><td>a<td>b<tr><td>c<td>d</table>');
    const rows = findAll(root, 'tr');

    expect(rows).toHaveLength(2);
    expect(findAll(rows[0], 'td').map(textOf)).toEqual(['a', 'b']);
    expect(findAll(rows[1], 'td').map(textOf)).toEqual(['c', 'd']);
  });

  it('closes <dt> and <dd> implicitly', () => {
    const root = parseHtml('<dl><dt>Term<dd>12 months<dt>Rate<dd>8%</dl>');

    expect(findAll(root, 'dt').map(textOf)).toEqual(['Term', 'Rate']);
    expect(findAll(root, 'dd').map(textOf)).toEqual(['12 months', '8%']);
  });
});

describe('parseHtml — malformed input tolerance', () => {
  it('ignores a stray closing tag with no matching open', () => {
    const root = parseHtml('<div>a</span>b</div>');
    expect(textOf(findFirst(root, 'div')!)).toBe('ab');
  });

  it('closes unclosed elements at end of input', () => {
    const root = parseHtml('<div><section><p>text');
    expect(textOf(root)).toBe('text');
    expect(findFirst(root, 'p')).not.toBeNull();
  });

  it('pops to the nearest matching ancestor on a mismatched close', () => {
    const root = parseHtml('<div><b>bold<i>both</div>after');
    expect(findFirst(root, 'div')).not.toBeNull();
    expect(textOf(root)).toBe('boldbothafter');
  });
});

describe('parseHtml — table structure is preserved', () => {
  it('keeps thead, tbody, rows, and header cells addressable', () => {
    const html = `<table>
      <thead><tr><th>Region</th><th>2025</th><th>2026</th></tr></thead>
      <tbody>
        <tr><th>North</th><td>4.2</td><td>5.1</td></tr>
        <tr><th>South</th><td>9.8</td><td>3.3</td></tr>
      </tbody>
    </table>`;
    const root = parseHtml(html);
    const table = findFirst(root, 'table')!;

    const headerRow = findFirst(findFirst(table, 'thead')!, 'tr')!;
    expect(findAll(headerRow, 'th').map(textOf)).toEqual(['Region', '2025', '2026']);

    const bodyRows = findAll(findFirst(table, 'tbody')!, 'tr');
    expect(bodyRows).toHaveLength(2);
    expect(textOf(findFirst(bodyRows[0], 'th')!)).toBe('North');
    expect(findAll(bodyRows[0], 'td').map(textOf)).toEqual(['4.2', '5.1']);
  });
});

// Coverage for the error-recovery behaviour that motivated moving to parse5.
describe('parseHtml — standards-compliant recovery (parse5)', () => {
  it('inserts an implicit tbody so rows are still addressable', () => {
    const root = parseHtml('<table><tr><td>a</td></tr></table>');
    const table = findFirst(root, 'table')!;

    expect(findFirst(table, 'tbody')).not.toBeNull();
    expect(findAll(table, 'tr')).toHaveLength(1);
    expect(findAll(table, 'td').map(textOf)).toEqual(['a']);
  });

  it('exposes colspan and rowspan as parsed integers', () => {
    const root = parseHtml(
      '<table><tr><td colspan="2">wide</td><td rowspan="3">tall</td><td>plain</td></tr></table>',
    );
    const cells = findAll(root, 'td');

    expect(spanAttr(cells[0], 'colspan')).toBe(2);
    expect(spanAttr(cells[0], 'rowspan')).toBe(1);
    expect(spanAttr(cells[1], 'rowspan')).toBe(3);
    expect(spanAttr(cells[2], 'colspan')).toBe(1);
  });

  it('defaults a malformed span attribute to 1 rather than NaN', () => {
    const root = parseHtml('<table><tr><td colspan="abc">x</td><td colspan="-4">y</td></tr></table>');
    const cells = findAll(root, 'td');

    expect(spanAttr(cells[0], 'colspan')).toBe(1);
    expect(spanAttr(cells[1], 'colspan')).toBe(1);
  });

  it('recovers a malformed table with cells outside a row', () => {
    const root = parseHtml('<table><td>orphan</td><tr><td>proper</td></tr></table>');

    // parse5 foster-parents content that cannot live in table scope; the
    // important property is that this does not throw and proper rows survive.
    expect(findAll(root, 'tr').length).toBeGreaterThanOrEqual(1);
    expect(textOf(root)).toContain('proper');
  });

  it('closes unclosed nested elements at end of input', () => {
    const root = parseHtml('<div><section><ul><li>one<li>two');

    expect(findAll(root, 'li').map(textOf)).toEqual(['one', 'two']);
    expect(findFirst(root, 'section')).not.toBeNull();
  });

  it('reconstructs nested formatting across a block boundary', () => {
    const root = parseHtml('<p><b>bold<i>both</p><p>after</i></p>');

    // The adoption agency algorithm is exactly what a hand-written parser gets
    // wrong; we only assert that no text is lost or duplicated.
    expect(textOf(root)).toBe('boldbothafter');
  });

  it('keeps custom elements and their attributes', () => {
    const root = parseHtml('<my-widget data-id="7"><span>inner</span></my-widget>');
    const widget = findFirst(root, 'my-widget')!;

    expect(widget.tag).toBe('my-widget');
    expect(attr(widget, 'data-id')).toBe('7');
    expect(textOf(widget)).toBe('inner');
  });

  it('drops comments including one that looks like markup', () => {
    const root = parseHtml('<div><!-- <p>ghost</p> -->real</div>');

    expect(findAll(root, 'p')).toEqual([]);
    expect(textOf(findFirst(root, 'div')!)).toBe('real');
  });

  it('treats script and style bodies as raw text, not markup', () => {
    const root = parseHtml(
      '<div><script>if (a < b) { document.write("<td>x</td>") }</script>' +
        '<style>td::before{content:"<p>"}</style><p>only</p></div>',
    );

    expect(findAll(root, 'p')).toHaveLength(1);
    expect(findAll(root, 'td')).toEqual([]);
    expect(textOf(findFirst(root, 'div')!)).toBe('only');
  });

  it('does not descend into inert template content', () => {
    const root = parseHtml('<div><template><p>inert</p></template><p>live</p></div>');

    expect(findAll(root, 'p').map(textOf)).toEqual(['live']);
  });
});

describe('findAll / findFirst', () => {
  it('accepts a list of tags and returns document order', () => {
    const root = parseHtml('<div><h1>a</h1><h2>b</h2><h1>c</h1></div>');
    expect(findAll(root, ['h1', 'h2']).map(textOf)).toEqual(['a', 'b', 'c']);
  });

  it('returns null from findFirst when nothing matches', () => {
    expect(findFirst(parseHtml('<p>x</p>'), 'table')).toBeNull();
  });
});
