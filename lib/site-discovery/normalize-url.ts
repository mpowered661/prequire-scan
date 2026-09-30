import { NORMALIZATION_VERSION } from './versions';

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'fbclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'ref',
  'referrer',
]);

export { NORMALIZATION_VERSION };

export function normalizeUrl(raw: string, base?: string):
  { ok: true; normalized: string; original: string } |
  { ok: false; reason: 'unparseable' | 'unsupported_scheme' } {
  let parsed: URL;
  try {
    parsed = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_scheme' };
  }

  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
    parsed.port = '';
  }
  parsed.hash = '';

  const params: Array<[string, string]> = [];
  parsed.searchParams.forEach((value, name) => {
    if (!TRACKING_PARAMS.has(name.toLowerCase())) params.push([name, value]);
  });
  params.sort(([aName, aValue], [bName, bValue]) => aName === bName ? aValue.localeCompare(bValue) : aName.localeCompare(bName));

  const query = params.map(([name, value]) => `${encodeComponent(name)}=${encodeComponent(value)}`).join('&');
  const auth = parsed.username || parsed.password
    ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
    : '';
  const host = parsed.host.toLowerCase();
  return {
    ok: true,
    original: raw,
    normalized: uppercasePercent(`${parsed.protocol}//${auth}${host}${parsed.pathname}${query ? `?${query}` : ''}`),
  };
}

function encodeComponent(value: string): string {
  return uppercasePercent(encodeURIComponent(value).replace(/%20/g, '+'));
}

function uppercasePercent(value: string): string {
  return value.replace(/%[0-9a-f]{2}/gi, match => match.toUpperCase());
}
