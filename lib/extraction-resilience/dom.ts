import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

// A thin adapter over parse5.
//
// parse5 is the standards-oriented HTML5 tree builder: it handles implicit
// <tbody>, foster parenting, the adoption agency algorithm, and the rest of the
// error-recovery behaviour that hand-written parsers approximate badly. It runs
// in plain Node with no browser and no renderer.
//
// Everything downstream of this file works against the small normalized shape
// below rather than parse5's node types, so the extraction logic did not have
// to change when the parser was swapped in, and could be pointed at a different
// parser again without touching EXTRACT_A.

export interface ElementNode {
  type: 'element';
  tag: string;
  attrs: Record<string, string>;
  children: DomNode[];
}

export interface TextNode {
  type: 'text';
  text: string;
}

export type DomNode = ElementNode | TextNode;

export const DOCUMENT_TAG = '#document';

// Excluded from textOf(): their content is code or styling, not page prose.
const NON_PROSE_ELEMENTS = new Set(['script', 'style']);

type P5Node = DefaultTreeAdapterMap['node'];
type P5Parent = DefaultTreeAdapterMap['parentNode'];
type P5Element = DefaultTreeAdapterMap['element'];

function element(tag: string, attrs: Record<string, string> = {}): ElementNode {
  return { type: 'element', tag, attrs, children: [] };
}

function hasChildNodes(node: P5Node): node is P5Parent {
  return Array.isArray((node as P5Parent).childNodes);
}

function convert(node: P5Node): DomNode | null {
  const name = node.nodeName;

  if (name === '#text') {
    const text = (node as DefaultTreeAdapterMap['textNode']).value;
    return text ? { type: 'text', text } : null;
  }
  // Comments and doctype carry no extractable meaning.
  if (name === '#comment' || name === '#documentType') return null;

  const el = node as P5Element;
  const attrs: Record<string, string> = {};
  for (const a of el.attrs ?? []) {
    // First occurrence wins, matching browser behaviour on duplicates.
    if (!(a.name in attrs)) attrs[a.name] = a.value;
  }

  const out = element(el.tagName ?? name, attrs);

  // <template> content lives off-tree in parse5 and is inert on the page, so it
  // is deliberately not descended into.
  if (hasChildNodes(node)) {
    for (const child of node.childNodes) {
      const converted = convert(child);
      if (converted) out.children.push(converted);
    }
  }

  return out;
}

export function parseHtml(html: string): ElementNode {
  const root = element(DOCUMENT_TAG);
  const document = parse(html ?? '');
  for (const child of document.childNodes) {
    const converted = convert(child);
    if (converted) root.children.push(converted);
  }
  return root;
}

/** Concatenated text of a subtree, excluding script and style content. */
export function textOf(node: DomNode): string {
  if (node.type === 'text') return node.text;
  if (NON_PROSE_ELEMENTS.has(node.tag)) return '';
  let out = '';
  for (const child of node.children) out += textOf(child);
  return out;
}

/** textOf() with runs of whitespace collapsed and the result trimmed. */
export function normalizedText(node: DomNode): string {
  return textOf(node).replace(/\s+/g, ' ').trim();
}

function tagSet(tags: string | string[]): Set<string> {
  return new Set(Array.isArray(tags) ? tags : [tags]);
}

/** Every descendant element, in document order. */
export function walkElements(node: ElementNode): ElementNode[] {
  const out: ElementNode[] = [];
  const walk = (n: ElementNode) => {
    for (const child of n.children) {
      if (child.type !== 'element') continue;
      out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

/** All descendant elements matching the tag(s), in document order. */
export function findAll(node: ElementNode, tags: string | string[]): ElementNode[] {
  const want = tagSet(tags);
  const out: ElementNode[] = [];
  const walk = (n: ElementNode) => {
    for (const child of n.children) {
      if (child.type !== 'element') continue;
      if (want.has(child.tag)) out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

export function findFirst(node: ElementNode, tags: string | string[]): ElementNode | null {
  const want = tagSet(tags);
  const walk = (n: ElementNode): ElementNode | null => {
    for (const child of n.children) {
      if (child.type !== 'element') continue;
      if (want.has(child.tag)) return child;
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(node);
}

/** Direct element children matching the tag(s) — no deep descent. */
export function childElements(node: ElementNode, tags?: string | string[]): ElementNode[] {
  const want = tags ? tagSet(tags) : null;
  return node.children.filter(
    (c): c is ElementNode => c.type === 'element' && (!want || want.has(c.tag)),
  );
}

export function attr(node: ElementNode, name: string): string | null {
  const v = node.attrs[name.toLowerCase()];
  return v === undefined ? null : v;
}

export function hasAttr(node: ElementNode, name: string): boolean {
  return name.toLowerCase() in node.attrs;
}

/** Positive integer span attribute (colspan/rowspan), defaulting to 1. */
export function spanAttr(node: ElementNode, name: 'colspan' | 'rowspan'): number {
  const raw = attr(node, name);
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : 1;
}
