export function extractSitemapDirectives(robotsTxt: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '');
    const match = /^\s*sitemap\s*:\s*(.*?)\s*$/i.exec(line);
    if (!match) continue;
    const value = match[1].trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= 10) break;
  }

  return out;
}
