import { MAX_LOC_ENTRIES, MAX_SITEMAP_BYTES } from './versions';

export type SitemapParseResult =
  | { ok: true; kind: 'index' | 'urlset'; locs: string[]; truncated: boolean }
  | { ok: false; reason: 'unsafe_xml' | 'oversize' | 'not_a_sitemap' };

export function parseSitemap(text: string, _sourceUrl: string, maxLocEntries = MAX_LOC_ENTRIES): SitemapParseResult {
  if (new TextEncoder().encode(text).length > MAX_SITEMAP_BYTES) {
    return { ok: false, reason: 'oversize' };
  }
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) {
    return { ok: false, reason: 'unsafe_xml' };
  }

  const kind = /<sitemapindex\b/i.test(text) ? 'index' : /<urlset\b/i.test(text) ? 'urlset' : null;
  if (!kind) return { ok: false, reason: 'not_a_sitemap' };

  const locs: string[] = [];
  let truncated = false;
  const locPattern = /<loc\b[^>]*>([\s\S]{0,20000}?)<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = locPattern.exec(text)) !== null) {
    const decoded = decodeXmlText(match[1]).trim();
    if (!decoded) continue;
    if (locs.length >= maxLocEntries) {
      truncated = true;
      break;
    }
    locs.push(decoded);
  }

  return { ok: true, kind, locs, truncated };
}

function decodeXmlText(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (entity, body: string) => {
    switch (body) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const codePoint = body.toLowerCase().startsWith('#x')
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0xffff) return entity;
        return String.fromCharCode(codePoint);
      }
    }
  });
}
