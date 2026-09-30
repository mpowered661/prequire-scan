import * as parse5 from 'parse5';
import { normalizeUrl } from './normalize-url';
import type { ExtractedLink, LinkPlacement } from './types';
import { LINK_EXTRACT_VERSION, MAX_ANCHOR_TEXT_CHARS, MAX_HREF_CHARS, MAX_LINKS_PER_PAGE } from './versions';

export { LINK_EXTRACT_VERSION };

type Node = {
  nodeName?: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: Node[];
};

export function extractLinks(html: string, sourceUrl: string, scopeOrigin: string): ExtractedLink[] {
  const document = parse5.parse(html) as Node;
  const hasBase = containsTag(document, 'base');
  const links: ExtractedLink[] = [];
  walk(document, [], (node, ancestors) => {
    if (links.length >= MAX_LINKS_PER_PAGE) return;
    if (tagName(node) !== 'a') return;
    const href = getAttr(node, 'href');
    if (href === null) return;
    links.push(buildLink(node, href, sourceUrl, scopeOrigin, ancestors, hasBase));
  });
  return links;
}

function buildLink(
  node: Node,
  hrefRaw: string,
  sourceUrl: string,
  scopeOrigin: string,
  ancestors: Node[],
  hasBase: boolean,
): ExtractedLink {
  const anchorText = collectText(node).replace(/\s+/g, ' ').trim().slice(0, MAX_ANCHOR_TEXT_CHARS);
  const placement = placementFor(ancestors);
  const base = {
    sourceUrl,
    hrefRaw,
    anchorText,
    placement,
    isInternal: false,
    eligibleForCheck: false,
  };
  if (hrefRaw.length > MAX_HREF_CHARS) {
    return { ...base, targetUrlNormalized: null, exclusionReason: 'href_too_long' };
  }
  if (hrefRaw === '') {
    return { ...base, targetUrlNormalized: null, exclusionReason: 'empty_href' };
  }
  if (hrefRaw.startsWith('#')) {
    return { ...base, targetUrlNormalized: null, exclusionReason: 'fragment_only' };
  }
  if (/[\s\u0000-\u001F\u007F]/.test(hrefRaw) || (hrefRaw.includes('://') && !/^(https?:)?\/\//i.test(hrefRaw))) {
    return { ...base, targetUrlNormalized: null, exclusionReason: 'unparseable' };
  }
  const normalized = normalizeUrl(hrefRaw, sourceUrl);
  if (!normalized.ok) {
    return { ...base, targetUrlNormalized: null, exclusionReason: normalized.reason };
  }
  const scope = new URL(scopeOrigin);
  const target = new URL(normalized.normalized);
  if (target.hostname.replace(/\.$/, '') === scope.hostname.replace(/\.$/, '') && target.port && target.port !== '80' && target.port !== '443') {
    return { ...base, targetUrlNormalized: normalized.normalized, isInternal: false, exclusionReason: 'port_not_allowed' };
  }
  const isInternal = target.origin === scopeOrigin;
  if (hasBase) {
    return { ...base, targetUrlNormalized: normalized.normalized, isInternal, exclusionReason: 'base_tag_present' };
  }
  if (!isInternal) {
    return { ...base, targetUrlNormalized: normalized.normalized, isInternal, exclusionReason: 'external' };
  }
  return { ...base, targetUrlNormalized: normalized.normalized, isInternal, eligibleForCheck: true, exclusionReason: null };
}

function walk(node: Node, ancestors: Node[], visit: (node: Node, ancestors: Node[]) => void): void {
  visit(node, ancestors);
  for (const child of node.childNodes ?? []) {
    walk(child, [...ancestors, node], visit);
  }
}

function containsTag(node: Node, tag: string): boolean {
  if (tagName(node) === tag) return true;
  return (node.childNodes ?? []).some(child => containsTag(child, tag));
}

function tagName(node: Node): string {
  return (node.tagName ?? '').toLowerCase();
}

function getAttr(node: Node, name: string): string | null {
  const attr = (node.attrs ?? []).find(item => item.name.toLowerCase() === name);
  return attr?.value ?? null;
}

function collectText(node: Node): string {
  if (node.nodeName === '#text') return node.value ?? '';
  return (node.childNodes ?? []).map(collectText).join('');
}

function placementFor(ancestors: Node[]): LinkPlacement {
  if (ancestors.some(node => tagName(node) === 'footer' || getAttr(node, 'role')?.toLowerCase() === 'contentinfo')) return 'footer';
  if (ancestors.some(node => tagName(node) === 'nav' || getAttr(node, 'role')?.toLowerCase() === 'navigation')) return 'nav';
  if (ancestors.some(node => ['main', 'article', 'section', 'body'].includes(tagName(node)))) return 'body';
  return 'unknown';
}
