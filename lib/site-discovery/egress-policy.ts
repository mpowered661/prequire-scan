import dns from 'node:dns';
import net from 'node:net';

export const IPV4_BLOCKED_PREFIXES: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

export const IPV6_BLOCKED_PREFIXES: ReadonlyArray<readonly [string, number]> = [
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (value < 0 || value > 255) return null;
    out = (out << 8) | value;
  }
  return out >>> 0;
}

function ipv6ToBigInt(ip: string): bigint | null {
  let value = ip.toLowerCase();
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  const pieces = value.split('::');
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(':') : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (pieces.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8) return null;
  let out = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    out = (out << 16n) + BigInt(parseInt(group, 16));
  }
  return out;
}

function prefixMatch(ip: bigint, prefix: bigint, bits: number, size: number): boolean {
  const shift = BigInt(size - bits);
  return (ip >> shift) === (prefix >> shift);
}

export function ipIsPublic(ip: string): boolean {
  if (net.isIP(ip) === 4) {
    const parsed = ipv4ToInt(ip);
    if (parsed === null) return false;
    return !IPV4_BLOCKED_PREFIXES.some(([prefix, bits]) => {
      const prefixInt = ipv4ToInt(prefix);
      return prefixInt !== null && prefixMatch(BigInt(parsed), BigInt(prefixInt), bits, 32);
    });
  }

  if (net.isIP(ip) === 6) {
    const parsed = ipv6ToBigInt(ip);
    const globalPrefix = ipv6ToBigInt('2000::');
    if (parsed === null || globalPrefix === null) return false;
    if (!prefixMatch(parsed, globalPrefix, 3, 128)) return false;
    return !IPV6_BLOCKED_PREFIXES.some(([prefix, bits]) => {
      const prefixInt = ipv6ToBigInt(prefix);
      return prefixInt !== null && prefixMatch(parsed, prefixInt, bits, 128);
    });
  }

  return false;
}

function reject(reason: string, error = reason) {
  return { ok: false as const, error, reason };
}

export async function validateUrl(url: string): Promise<
  { ok: true; host: string; port: number; url: string } |
  { ok: false; error: string; reason: string }
> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return reject('unparseable');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return reject('unsupported_scheme');
  }

  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  if (port !== 80 && port !== 443) {
    return reject('port_not_allowed');
  }

  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (/^\d+$/.test(host) || /^0x/i.test(host)) {
    return reject('host_evasion');
  }

  if (net.isIP(host) !== 0) {
    if (!ipIsPublic(host)) return reject('ip_not_public');
    return { ok: true, host, port, url: parsed.toString() };
  }

  if (!/^[A-Za-z0-9]([A-Za-z0-9\-.]{0,253}[A-Za-z0-9])?$/.test(host)) {
    return reject('invalid_host');
  }

  // Residual parity risk: Node fetch re-resolves DNS after validation, so a
  // TOCTOU DNS rebind remains possible just as fp_validate_url + curl did.
  const [v4, v6] = await Promise.allSettled([
    dns.promises.resolve4(host),
    dns.promises.resolve6(host),
  ]);
  const addresses = [
    ...(v4.status === 'fulfilled' ? v4.value : []),
    ...(v6.status === 'fulfilled' ? v6.value : []),
  ];
  if (addresses.length === 0) return reject('dns_no_addresses');
  if (!addresses.every(ipIsPublic)) return reject('dns_not_public');

  return { ok: true, host, port, url: parsed.toString() };
}
