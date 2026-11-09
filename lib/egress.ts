// Server-side egress guard for every fetch the scanner makes to a visitor-supplied URL.
// Mirrors the app's hardened PHP policy (prequire-app lib/egress.php, 2026-09-14):
// http/https only, ports 80/443, no URL credentials, every resolved address must be
// public, every redirect hop re-validated, response body capped, overall deadline.
// The address check runs inside the socket's DNS lookup, so the address that is
// validated is the address that is connected to (no DNS-rebinding window).
import { BlockList, isIP, type LookupFunction } from 'node:net';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';

// IANA special-purpose registry (RFC 6890) + multicast — same table as lib/egress.php.
const IPV4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, incl. 169.254.169.254 cloud metadata
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];
// Special-use blocks inside 2000::/3. Everything outside 2000::/3 (loopback, mapped
// IPv4, NAT64, unique-local, link-local, multicast) is refused before this table.
const IPV6_BLOCKED: [string, number][] = [
  ['2001::', 32], ['2001:2::', 48], ['2001:10::', 28], ['2001:20::', 28],
  ['2001:db8::', 32], ['2002::', 16],
];

const blocked = new BlockList();
for (const [a, b] of IPV4_BLOCKED) blocked.addSubnet(a, b, 'ipv4');
for (const [a, b] of IPV6_BLOCKED) blocked.addSubnet(a, b, 'ipv6');

export function isPublicIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !blocked.check(ip, 'ipv4');
  if (family === 6) {
    const first = parseInt(ip.split(':')[0] || '0', 16);
    if ((first & 0xe000) !== 0x2000) return false; // outside global unicast 2000::/3
    return !blocked.check(ip, 'ipv6');
  }
  return false;
}

/** Thrown for any refused destination. `message` is safe to show visitors; `log` is not. */
export class EgressError extends Error {
  constructor(message: string, readonly log: string) {
    super(message);
    this.name = 'EgressError';
  }
}

export function validateTarget(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new EgressError('Invalid URL', 'unparseable');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new EgressError('Only http and https URLs can be scanned.', `scheme=${u.protocol}`);
  }
  if (u.username || u.password) {
    throw new EgressError('URLs with credentials cannot be scanned.', 'userinfo');
  }
  const port = u.port === '' ? (u.protocol === 'https:' ? 443 : 80) : Number(u.port);
  if (port !== 80 && port !== 443) {
    throw new EgressError('Only standard web ports (80 and 443) can be scanned.', `port=${port}`);
  }
  // WHATWG URL already canonicalises decimal/hex/octal IPv4 forms to dotted quads.
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (!isPublicIp(host)) throw new EgressError(BLOCKED_MESSAGE, 'blocked-ip-literal');
  } else if (!/^[A-Za-z0-9]([A-Za-z0-9\-.]{0,253}[A-Za-z0-9])?$/.test(host)) {
    throw new EgressError('Unsupported host name.', 'non-hostname chars');
  }
  return u;
}

const BLOCKED_MESSAGE = 'This address cannot be scanned. Only public websites are supported.';

type RawLookup = (
  hostname: string,
  options: { all: true; family?: number },
  cb: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

/** A socket lookup that refuses to connect unless every resolved address is public. */
export function guardedLookup(raw: RawLookup = dns.lookup as unknown as RawLookup): LookupFunction {
  return (hostname, options, callback) => {
    const family = typeof options.family === 'number' ? options.family : 0;
    raw(hostname, { all: true, family }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      if (!addresses.length || addresses.some((a) => !isPublicIp(a.address))) {
        return callback(new EgressError(BLOCKED_MESSAGE, 'resolved to non-public IP'), '', 0);
      }
      if ((options as { all?: boolean }).all) {
        return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, addresses);
      }
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

export interface HopResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface HopOptions {
  method: 'GET' | 'HEAD';
  headers: Record<string, string>;
  deadline: number;
  maxBytes: number;
  lookup: LookupFunction;
}

/** One HTTP exchange with no redirect following. Rejects on deadline or oversize body. */
export function httpHop(url: URL, opts: HopOptions): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    const remaining = opts.deadline - Date.now();
    if (remaining <= 0) return reject(timeoutError());
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method: opts.method,
        headers: { ...opts.headers, 'Accept-Encoding': 'gzip, deflate, br' },
        lookup: opts.lookup,
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
        }
        const status = res.statusCode ?? 0;
        if (opts.method === 'HEAD' || (status >= 300 && status < 400)) {
          res.resume();
          clearTimeout(timer);
          return resolve({ status, headers, body: Buffer.alloc(0) });
        }
        const enc = (headers['content-encoding'] ?? '').toLowerCase();
        const stream: Readable =
          enc === 'gzip' ? res.pipe(zlib.createGunzip())
          : enc === 'deflate' ? res.pipe(zlib.createInflate())
          : enc === 'br' ? res.pipe(zlib.createBrotliDecompress())
          : res;
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on('data', (c: Buffer) => {
          size += c.length; // counted after decompression, so a compression bomb is capped too
          if (size > opts.maxBytes) {
            req.destroy();
            reject(new EgressError('The page is too large to scan.', `body>${opts.maxBytes}`));
            return;
          }
          chunks.push(c);
        });
        stream.on('end', () => {
          clearTimeout(timer);
          resolve({ status, headers, body: Buffer.concat(chunks) });
        });
        stream.on('error', (e) => { clearTimeout(timer); reject(e); });
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      reject(timeoutError());
    }, remaining);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

function timeoutError(): Error {
  const e = new Error('Request timed out');
  e.name = 'TimeoutError';
  return e;
}

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB, same ceiling as lib/egress.php

/**
 * fetch() replacement for visitor-supplied URLs. Returns a standard Response.
 * Throws EgressError for refused destinations, oversize bodies and redirect loops;
 * a TimeoutError when the overall deadline passes.
 */
export async function safeFetch(
  raw: string,
  opts: SafeFetchOptions = {},
  deps: { hop?: typeof httpHop; lookup?: LookupFunction } = {},
): Promise<Response> {
  const hop = deps.hop ?? httpHop;
  const lookup = deps.lookup ?? guardedLookup();
  const method = opts.method ?? 'GET';
  const maxRedirects = opts.maxRedirects ?? 5;
  const deadline = Date.now() + (opts.timeoutMs ?? 10000);
  let current = raw;
  for (let redirects = 0; ; redirects++) {
    const url = validateTarget(current);
    const r = await hop(url, {
      method,
      headers: opts.headers ?? {},
      deadline,
      maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
      lookup,
    });
    const location = r.headers['location'];
    if (r.status >= 300 && r.status < 400 && location) {
      if (redirects >= maxRedirects) throw new EgressError('Too many redirects.', `redirect cap at ${url.host}`);
      current = new URL(location, url).toString();
      continue;
    }
    const noBody = method === 'HEAD' || r.status === 204 || r.status === 304;
    if (r.status < 200 || r.status > 599) {
      throw new EgressError('The site returned an unexpected response.', `status=${r.status}`);
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(r.headers)) {
      try { headers.set(k, v); } catch { /* skip a header value the Fetch spec rejects */ }
    }
    return new Response(noBody ? null : new Uint8Array(r.body), { status: r.status, headers });
  }
}
