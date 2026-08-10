import { extractJsonLd } from '@/lib/scanPrompt';
import {
  parseHtml,
  findAll,
  findFirst,
  childElements,
  walkElements,
  normalizedText,
  attr,
  hasAttr,
  spanAttr,
  type ElementNode,
} from './dom';
import {
  parseValues,
  isBareValue,
  unitsFromContext,
  qualifiersFromText,
  dedupeQualifiers,
  dedupeUnits,
} from './values';
import type {
  StructuredExtraction,
  ValueBinding,
  StructuralRelation,
  TableModel,
  FigureModel,
  FootnoteModel,
  HeadingNode,
  SchemaModel,
  AssetCounts,
  IdentitySignals,
  UnitAnnotation,
  Dimension,
  Qualifier,
} from './types';

// EXTRACT_A — the DOM-aware reference extraction, built on parse5.
//
// Its job is to record what the page actually says with its relationships
// intact: a table cell bound to both its row header and its column header, a
// value with the unit it is measured in, and any claim qualifier that
// conditions it. Those three are kept apart deliberately — see types.ts.

const IMAGE_CANDIDATE_CAP = 25;

const SEMANTIC_SECTION_TAGS = [
  'main', 'nav', 'article', 'section', 'header', 'footer', 'aside',
];

const BLOCK_TEXT_TAGS = new Set([
  'p', 'li', 'dd', 'dt', 'td', 'th', 'figcaption', 'caption', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'section', 'article', 'main',
  'header', 'footer', 'aside', 'nav', 'address', 'pre',
]);

const GENERIC_TITLES = new Set([
  'home', 'homepage', 'welcome', 'index', 'untitled', 'page', 'document',
  'new page', 'default',
]);

const ORG_TYPES = new Set([
  'organization', 'localbusiness', 'corporation', 'ngo', 'educationalorganization',
  'governmentorganization', 'medicalorganization', 'onlinebusiness', 'brand',
]);

const TITLE_SEPARATOR = /\s[|–—·»]\s/;

/** Per-call id factory: ids stay stable across runs and never leak between requests. */
function makeIds() {
  let seq = 0;
  return (prefix: string) => `${prefix}-${(seq += 1)}`;
}

// ── Small tree helpers ───────────────────────────────────────

function collectIds(root: ElementNode): Map<string, ElementNode> {
  const map = new Map<string, ElementNode>();
  for (const el of walkElements(root)) {
    const id = attr(el, 'id');
    if (id && !map.has(id)) map.set(id, el);
  }
  return map;
}

/** Text of an element, ignoring the content of the given descendant tags. */
function textExcluding(node: ElementNode, exclude: Set<string>): string {
  let out = '';
  const walk = (n: ElementNode) => {
    for (const c of n.children) {
      if (c.type === 'text') out += c.text;
      else if (!exclude.has(c.tag)) walk(c);
    }
  };
  walk(node);
  return out.replace(/\s+/g, ' ').trim();
}

function metaContent(
  root: ElementNode,
  matchAttr: 'name' | 'property',
  value: string,
): string | null {
  for (const meta of findAll(root, 'meta')) {
    if ((attr(meta, matchAttr) ?? '').toLowerCase() === value) {
      const content = attr(meta, 'content');
      if (content && content.trim()) return content.trim();
    }
  }
  return null;
}

function nonEmpty(s: string | null | undefined): string | null {
  const t = (s ?? '').trim();
  return t ? t : null;
}

// ── Structured data ──────────────────────────────────────────

function walkSchemaNodes(
  nodes: unknown[],
  visit: (obj: Record<string, unknown>, path: string) => void,
) {
  const seen = new Set<unknown>();
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    const obj = node as Record<string, unknown>;
    visit(obj, path);
    for (const [key, val] of Object.entries(obj)) {
      if (key === '@context') continue;
      walk(val, path ? `${path}.${key}` : key);
    }
  };
  for (const n of nodes) walk(n, '');
}

function buildSchemaModel(rawHtml: string): SchemaModel {
  const parsed = extractJsonLd(rawHtml);
  const organizationNames: string[] = [];
  const declaredValues: { path: string; value: string }[] = [];

  walkSchemaNodes(parsed.nodes, (obj, path) => {
    const rawType = obj['@type'];
    const typeList = (Array.isArray(rawType) ? rawType : [rawType]).filter(
      (t): t is string => typeof t === 'string',
    );
    const name = typeof obj.name === 'string' ? obj.name.trim() : null;
    if (name && typeList.some((t) => ORG_TYPES.has(t.toLowerCase()))) {
      if (!organizationNames.includes(name)) organizationNames.push(name);
    }
    for (const [key, val] of Object.entries(obj)) {
      if (key.startsWith('@')) continue;
      if (typeof val === 'number') {
        declaredValues.push({ path: path ? `${path}.${key}` : key, value: String(val) });
      } else if (
        typeof val === 'string' &&
        /^\s*[$€£¥]?\s*\d[\d,]*(?:\.\d+)?\s*%?\s*$/.test(val)
      ) {
        declaredValues.push({ path: path ? `${path}.${key}` : key, value: val.trim() });
      }
    }
  });

  return {
    types: parsed.types,
    blockCount: parsed.blockCount,
    hasMalformed: parsed.hasMalformed,
    declaredValues,
    organizationNames,
  };
}

// ── Identity ─────────────────────────────────────────────────

function buildIdentity(
  root: ElementNode,
  schema: SchemaModel,
  outline: HeadingNode[],
): IdentitySignals {
  const titleEl = findFirst(root, 'title');
  const title = titleEl ? nonEmpty(normalizedText(titleEl)) : null;

  let canonical: string | null = null;
  for (const link of findAll(root, 'link')) {
    if ((attr(link, 'rel') ?? '').toLowerCase() === 'canonical') {
      canonical = nonEmpty(attr(link, 'href'));
      break;
    }
  }

  const metaDescription = metaContent(root, 'name', 'description');
  const ogSiteName = metaContent(root, 'property', 'og:site_name');
  const ogTitle = metaContent(root, 'property', 'og:title');
  const h1s = outline.filter((h) => h.level === 1);
  const primaryH1 = h1s.length > 0 ? h1s[0].text : null;
  const schemaOrgName = schema.organizationNames[0] ?? null;

  const titleSuffix = (() => {
    if (!title) return null;
    const parts = title.split(TITLE_SEPARATOR).map((p) => p.trim()).filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 1] : null;
  })();

  let resolvedEntity: string | null = null;
  let entitySource: IdentitySignals['entitySource'] = 'none';
  if (schemaOrgName) {
    resolvedEntity = schemaOrgName;
    entitySource = 'json_ld';
  } else if (ogSiteName) {
    resolvedEntity = ogSiteName;
    entitySource = 'og_site_name';
  } else if (titleSuffix) {
    resolvedEntity = titleSuffix;
    entitySource = 'title_suffix';
  }

  const titleTopic = (() => {
    if (!title) return null;
    const first = title.split(TITLE_SEPARATOR)[0].trim();
    if (!first || GENERIC_TITLES.has(first.toLowerCase())) return null;
    return first;
  })();

  let pageTopic: string | null = null;
  let topicSource: IdentitySignals['topicSource'] = 'none';
  if (primaryH1 && h1s.length === 1) {
    pageTopic = primaryH1;
    topicSource = 'h1';
  } else if (ogTitle) {
    pageTopic = ogTitle;
    topicSource = 'og_title';
  } else if (primaryH1) {
    pageTopic = primaryH1;
    topicSource = 'h1';
  } else if (titleTopic) {
    pageTopic = titleTopic;
    topicSource = 'title';
  }

  return {
    canonicalUrl: canonical,
    title,
    metaDescription,
    primaryH1,
    ogSiteName,
    ogTitle,
    schemaOrgName,
    titleSuffix,
    resolvedEntity,
    entitySource,
    pageTopic,
    topicSource,
  };
}

// ── Tables ───────────────────────────────────────────────────

interface TableExtraction {
  model: TableModel;
  bindings: ValueBinding[];
  relations: StructuralRelation[];
  consumed: Set<ElementNode>;
}

function extractTable(
  table: ElementNode,
  index: number,
  footnotesByHost: Map<ElementNode, Qualifier[]>,
  nextId: (p: string) => string,
): TableExtraction {
  const consumed = new Set<ElementNode>([table]);
  for (const el of walkElements(table)) consumed.add(el);

  const captionEl = findFirst(table, 'caption');
  const caption = captionEl ? textExcluding(captionEl, new Set(['sup'])) : null;

  const allRows = findAll(table, 'tr');
  const thead = findFirst(table, 'thead');
  let headerRow: ElementNode | null = thead ? findFirst(thead, 'tr') : null;
  if (!headerRow && allRows.length > 0) {
    const cells = childElements(allRows[0], ['td', 'th']);
    if (cells.length > 0 && cells.every((c) => c.tag === 'th')) headerRow = allRows[0];
  }

  // Column headers expanded by colspan so index arithmetic stays aligned.
  const columnHeaders: string[] = [];
  if (headerRow) {
    for (const cell of childElements(headerRow, ['td', 'th'])) {
      const text = normalizedText(cell);
      for (let i = 0; i < spanAttr(cell, 'colspan'); i++) columnHeaders.push(text);
    }
  }

  const bodyRows = allRows.filter((r) => r !== headerRow);

  // rowspan makes a cell's column index depend on rows above it. Rather than
  // guess and risk attributing a number to the wrong year, the whole table's
  // column attribution is marked unresolved and those facts are reported
  // undeterminable.
  const hasRowspan = bodyRows.some((r) =>
    childElements(r, ['td', 'th']).some((c) => spanAttr(c, 'rowspan') > 1),
  );

  const rowHeaders: string[] = [];
  const rows: string[][] = [];
  const parsedRows: { label: string | null; cells: ElementNode[] }[] = [];

  for (const tr of bodyRows) {
    const cells = childElements(tr, ['td', 'th']);
    if (cells.length === 0) continue;

    let label: string | null = null;
    let valueCells = cells;
    if (cells[0].tag === 'th') {
      label = normalizedText(cells[0]);
      valueCells = cells.slice(1);
    } else if (cells.length >= 2) {
      label = normalizedText(cells[0]);
      valueCells = cells.slice(1);
    }

    if (label) rowHeaders.push(label);
    rows.push(valueCells.map((c) => normalizedText(c)));
    parsedRows.push({ label, cells: valueCells });
  }

  const valueColumnCount = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const hasColumnDimension = valueColumnCount > 1;

  const model: TableModel = {
    index,
    caption: nonEmpty(caption),
    columnHeaders,
    rowHeaders,
    rows,
    hasColumnDimension,
    isKeyValue: !hasColumnDimension,
  };

  // Caption-level annotations apply to every value in the table.
  const captionUnits = caption ? unitsFromContext(caption, 'caption') : [];
  const captionQualifiers = caption ? qualifiersFromText(caption, 'caption') : [];
  const captionFootnotes = captionEl ? footnotesByHost.get(captionEl) ?? [] : [];

  const bindings: ValueBinding[] = [];
  const relations: StructuralRelation[] = [];

  for (const { label, cells } of parsedRows) {
    // Offset when the header row includes the row-label column.
    const headerOffset = columnHeaders.length > cells.length ? 1 : 0;
    let colCursor = 0;

    for (const cell of cells) {
      const colspan = spanAttr(cell, 'colspan');
      const colIndex = colCursor;
      colCursor += colspan;

      const cellText = normalizedText(cell);
      const parsed = parseValues(cellText);
      if (parsed.length === 0) continue;
      const primary = parsed[0];

      const units: UnitAnnotation[] = dedupeUnits([...primary.units, ...captionUnits]);
      const dimensions: Dimension[] = [];
      const qualifiers: Qualifier[] = dedupeQualifiers([
        ...captionQualifiers,
        ...captionFootnotes,
        ...qualifiersFromText(cellText, 'inline'),
        ...(label ? qualifiersFromText(label, 'row_header') : []),
      ]);

      let dimensionUnresolved = false;

      if (hasColumnDimension) {
        if (hasRowspan || colspan > 1) {
          dimensionUnresolved = true;
        } else {
          const header = columnHeaders[colIndex + headerOffset];
          if (header) {
            dimensions.push({ label: header, source: 'column_header' });
            relations.push({
              id: nextId('rel'),
              kind: 'table_cell_to_column_header',
              from: `${label ?? '?'}/${cellText}`,
              to: header,
            });
          }
        }
      }

      if (label) {
        relations.push({
          id: nextId('rel'),
          kind: 'table_cell_to_row_header',
          from: cellText,
          to: label,
        });
      }

      bindings.push({
        id: nextId('bind'),
        label,
        labelSource: label ? 'row_header' : 'none',
        value: primary.value,
        units,
        dimensions,
        qualifiers,
        dimensionUnresolved,
        origin: 'table',
        context: [caption, label, cellText].filter(Boolean).join(' — '),
      });
    }
  }

  return { model, bindings, relations, consumed };
}

// ── Footnotes ────────────────────────────────────────────────

function extractFootnotes(
  root: ElementNode,
  idMap: Map<string, ElementNode>,
  nextId: (p: string) => string,
): {
  models: FootnoteModel[];
  byHost: Map<ElementNode, Qualifier[]>;
  relations: StructuralRelation[];
} {
  const models: FootnoteModel[] = [];
  const byHost = new Map<ElementNode, Qualifier[]>();
  const relations: StructuralRelation[] = [];

  // Precompute each element's block-level ancestors once.
  const ancestors = new Map<ElementNode, ElementNode[]>();
  const walk = (n: ElementNode, chain: ElementNode[]) => {
    for (const c of n.children) {
      if (c.type !== 'element') continue;
      ancestors.set(c, chain);
      walk(c, [...chain, c]);
    }
  };
  walk(root, []);

  for (const anchor of findAll(root, 'a')) {
    const href = attr(anchor, 'href');
    if (!href || !href.startsWith('#') || href.length < 2) continue;
    const marker = normalizedText(anchor);
    if (!marker || marker.length > 3 || !/^[\d*†‡§¶]+$/.test(marker)) continue;

    const targetId = href.slice(1);
    const target = idMap.get(targetId) ?? null;
    const text = target ? normalizedText(target) : null;

    models.push({ marker, targetId, text, reachable: !!target });
    relations.push({
      id: nextId('rel'),
      kind: 'footnote_ref_to_text',
      from: marker,
      to: targetId,
    });

    const qualifier: Qualifier = { kind: 'footnote', text: marker, source: 'footnote_ref' };
    for (const host of (ancestors.get(anchor) ?? []).filter((x) => BLOCK_TEXT_TAGS.has(x.tag))) {
      const list = byHost.get(host) ?? [];
      list.push(qualifier);
      byHost.set(host, list);
    }
  }

  return { models, byHost, relations };
}

// ── Line-level bindings ──────────────────────────────────────

function leafBlocks(root: ElementNode): ElementNode[] {
  const out: ElementNode[] = [];
  const walk = (n: ElementNode) => {
    for (const c of n.children) {
      if (c.type !== 'element') continue;
      if (BLOCK_TEXT_TAGS.has(c.tag) && findAll(c, [...BLOCK_TEXT_TAGS]).length === 0) {
        out.push(c);
        continue;
      }
      walk(c);
    }
  };
  walk(root);
  return out;
}

const INLINE_LABEL_RE = /^(.{2,60}?)\s*[:—–]\s*(.+)$/;

function bindingsFromLine(
  text: string,
  origin: 'paragraph' | 'list',
  hostQualifiers: Qualifier[],
  footnoteText: string[],
  nextId: (p: string) => string,
): ValueBinding[] {
  const out: ValueBinding[] = [];

  for (const raw of text.split(/(?<=[.!?])\s+/)) {
    const sentence = raw.trim().replace(/[.;,]$/, '');
    if (!sentence) continue;

    // Qualifiers may sit anywhere in the sentence, and any footnote referenced
    // from this block carries its small print onto the claim.
    const qualifiers: Qualifier[] = dedupeQualifiers([
      ...hostQualifiers,
      ...qualifiersFromText(sentence, 'inline'),
      ...footnoteText.flatMap((t) => qualifiersFromText(t, 'footnote_ref')),
    ]);

    const m = INLINE_LABEL_RE.exec(sentence);
    if (m && /[A-Za-z]/.test(m[1])) {
      const label = m[1].trim();
      const parsed = parseValues(m[2]);
      if (parsed.length > 0) {
        out.push({
          id: nextId('bind'),
          label,
          labelSource: 'inline_label',
          value: parsed[0].value,
          units: parsed[0].units,
          dimensions: [],
          qualifiers,
          dimensionUnresolved: false,
          origin,
          context: sentence,
        });
        continue;
      }
    }

    const bare = isBareValue(sentence);
    if (bare) {
      out.push({
        id: nextId('bind'),
        label: null,
        labelSource: 'none',
        value: bare.value,
        units: bare.units,
        dimensions: [],
        qualifiers,
        dimensionUnresolved: false,
        origin,
        context: sentence,
      });
    }
  }

  return out;
}

// ── Entry point ──────────────────────────────────────────────

export function extractA(url: string, rawHtml: string): StructuredExtraction {
  const nextId = makeIds();
  const root = parseHtml(rawHtml ?? '');
  const idMap = collectIds(root);

  const outline: HeadingNode[] = findAll(root, ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
    .map((h) => ({ level: Number(h.tag[1]), text: normalizedText(h) }))
    .filter((h) => h.text.length > 0);

  const schema = buildSchemaModel(rawHtml ?? '');
  const identity = buildIdentity(root, schema, outline);

  const footnotes = extractFootnotes(root, idMap, nextId);
  const relations: StructuralRelation[] = [...footnotes.relations];
  const bindings: ValueBinding[] = [];
  const consumed = new Set<ElementNode>();

  // A footnote's own body resolves a marker; it is not a fact of its own.
  const footnoteTargets = new Set<ElementNode>();
  for (const fn of footnotes.models) {
    if (!fn.targetId) continue;
    const target = idMap.get(fn.targetId);
    if (target) {
      consumed.add(target);
      footnoteTargets.add(target);
    }
  }

  // Tables
  const tables: TableModel[] = [];
  findAll(root, 'table').forEach((table, i) => {
    const result = extractTable(table, i, footnotes.byHost, nextId);
    tables.push(result.model);
    bindings.push(...result.bindings);
    relations.push(...result.relations);
    for (const el of result.consumed) consumed.add(el);
  });

  // Definition lists
  for (const dl of findAll(root, 'dl')) {
    const children = childElements(dl, ['dt', 'dd']);
    let pendingTerm: string | null = null;
    for (const child of children) {
      consumed.add(child);
      if (child.tag === 'dt') {
        pendingTerm = normalizedText(child);
        continue;
      }
      const valueText = normalizedText(child);
      const parsed = parseValues(valueText);
      if (pendingTerm) {
        relations.push({
          id: nextId('rel'),
          kind: 'definition_term_to_value',
          // Dependent first, anchor second — see StructuralRelation.
          from: valueText,
          to: pendingTerm,
        });
      }
      if (parsed.length > 0) {
        bindings.push({
          id: nextId('bind'),
          label: pendingTerm,
          labelSource: pendingTerm ? 'definition_term' : 'none',
          value: parsed[0].value,
          units: parsed[0].units,
          dimensions: [],
          qualifiers: dedupeQualifiers([
            ...qualifiersFromText(valueText, 'inline'),
            ...(pendingTerm ? qualifiersFromText(pendingTerm, 'inline') : []),
            ...(footnotes.byHost.get(child) ?? []),
          ]),
          dimensionUnresolved: false,
          origin: 'definition_list',
          context: [pendingTerm, valueText].filter(Boolean).join(': '),
        });
      }
    }
  }

  // Figures
  const figures: FigureModel[] = findAll(root, 'figure').map((fig, i) => {
    const img = findFirst(fig, 'img');
    const cap = findFirst(fig, 'figcaption');
    const caption = cap ? normalizedText(cap) : null;
    if (caption) {
      relations.push({
        id: nextId('rel'),
        kind: 'figure_to_caption',
        from: caption,
        to: img ? attr(img, 'src') ?? `figure-${i}` : `figure-${i}`,
      });
    }
    return {
      index: i,
      imageSrc: img ? attr(img, 'src') : null,
      imageAlt: img ? attr(img, 'alt') : null,
      caption,
    };
  });

  // Remaining prose lines
  const footnoteTextByHost = new Map<ElementNode, string[]>();
  for (const [host, quals] of footnotes.byHost) {
    const texts = quals
      .map((q) => footnotes.models.find((f) => f.marker === q.text)?.text)
      .filter((t): t is string => !!t);
    if (texts.length) footnoteTextByHost.set(host, texts);
  }

  for (const block of leafBlocks(root)) {
    if (consumed.has(block) || footnoteTargets.has(block)) continue;
    if (/^h[1-6]$/.test(block.tag)) continue; // headings are structure, not facts
    const text = normalizedText(block);
    if (!text || !/\d/.test(text)) continue;
    bindings.push(
      ...bindingsFromLine(
        text,
        block.tag === 'li' ? 'list' : 'paragraph',
        footnotes.byHost.get(block) ?? [],
        footnoteTextByHost.get(block) ?? [],
        nextId,
      ),
    );
  }

  // Heading → content relations
  outline.forEach((h, i) => {
    relations.push({
      id: nextId('rel'),
      kind: 'heading_to_content',
      from: h.text,
      to: outline[i + 1]?.text ?? '(end)',
    });
  });

  // Assets
  const imgs = findAll(root, 'img');
  let withAlt = 0;
  let withoutAlt = 0;
  let decorative = 0;
  const imageCandidates: AssetCounts['imageCandidates'] = [];
  for (const img of imgs) {
    const present = hasAttr(img, 'alt');
    const alt = attr(img, 'alt');
    if (!present) withoutAlt += 1;
    else if ((alt ?? '').trim() === '') decorative += 1;
    else withAlt += 1;
    if (imageCandidates.length < IMAGE_CANDIDATE_CAP) {
      imageCandidates.push({ src: attr(img, 'src') ?? '', alt, hasAlt: present });
    }
  }

  const assets: AssetCounts = {
    images: { total: imgs.length, withAlt, withoutAlt, decorative },
    imageCandidates,
    tables: tables.length,
    svg: findAll(root, 'svg').length,
    canvas: findAll(root, 'canvas').length,
    iframes: findAll(root, 'iframe').length,
    jsonLdBlocks: schema.blockCount,
  };

  const body = findFirst(root, 'body');
  const text = normalizedText(body ?? root);

  const semanticSections = SEMANTIC_SECTION_TAGS.filter(
    (tag) => findFirst(root, tag) !== null,
  );

  return {
    url,
    identity,
    outline,
    bindings,
    relations,
    tables,
    figures,
    footnotes: footnotes.models,
    schema,
    assets,
    semanticSections,
    text,
  };
}
