import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { isPublicIp, validateTarget, guardedLookup, safeFetch, httpHop, EgressError, type HopResult } from './egress';

describe('isPublicIp — same table as prequire-app lib/egress.php', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    '64:ff9b::a00:1', '2001:db8::1', '2002::1', 'ff02::1', 'not-an-ip',
  ])('blocks %s', (ip) => expect(isPublicIp(ip)).toBe(false));

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '2a00:1450:4001::1'])(
    'allows public %s', (ip) => expect(isPublicIp(ip)).toBe(true),
  );
});

describe('validateTarget', () => {
  it.each([
    ['file:///etc/passwd', /http and https/],
    ['ftp://example.com/', /http and https/],
    ['gopher://example.com/', /http and https/],
    ['http://user:pw@example.com/', /credentials/],
    ['http://example.com:8080/', /ports/],
    ['https://example.com:22/', /ports/],
    ['http://127.0.0.1/', /cannot be scanned/],
    ['http://2130706433/', /cannot be scanned/], // decimal 127.0.0.1
    ['http://0x7f000001/', /cannot be scanned/], // hex 127.0.0.1
    ['http://0177.0.0.1/', /cannot be scanned/], // octal 127.0.0.1
    ['http://169.254.169.254/latest/meta-data/', /cannot be scanned/],
    ['http://[::1]/', /cannot be scanned/],
    ['http://[::ffff:7f00:1]/', /cannot be scanned/],
    ['http://exa_mple.com/', /Unsupported host/],
  ])('refuses %s', (raw, msg) => {
    expect(() => validateTarget(raw)).toThrow(EgressError);
    expect(() => validateTarget(raw)).toThrow(msg);
  });

  it.each(['https://example.com/', 'http://example.com/a?b=1', 'https://example.com:443/', 'http://www.example.co.uk/', 'https://8.8.8.8/'])(
    'accepts %s', (raw) => expect(validateTarget(raw).toString()).toBe(new URL(raw).toString()),
  );
});

describe('guardedLookup — checked at connect time, so DNS rebinding cannot slip through', () => {
  const fakeDns = (addrs: { address: string; family: number }[]) =>
    vi.fn((_h: string, _o: unknown, cb: (e: null, a: typeof addrs) => void) => cb(null, addrs));

  it('refuses a hostname that resolves to a private address', async () => {
    const lookup = guardedLookup(fakeDns([{ address: '10.0.0.5', family: 4 }]));
    const err = await new Promise((r) => lookup('internal.example', {}, (e) => r(e)));
    expect(err).toBeInstanceOf(EgressError);
  });

  it('refuses when ANY resolved address is non-public (mixed answer)', async () => {
    const lookup = guardedLookup(fakeDns([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]));
    const err = await new Promise((r) => lookup('mixed.example', {}, (e) => r(e)));
    expect(err).toBeInstanceOf(EgressError);
  });

  it('passes public addresses through in both callback shapes', async () => {
    const addrs = [{ address: '93.184.216.34', family: 4 }];
    const single = await new Promise((r) => guardedLookup(fakeDns(addrs))('ok.example', {}, (e, a, f) => r([e, a, f])));
    expect(single).toEqual([null, '93.184.216.34', 4]);
    const all = await new Promise((r) =>
      guardedLookup(fakeDns(addrs))('ok.example', { all: true }, (e, a) => r([e, a])),
    );
    expect(all).toEqual([null, addrs]);
  });

  it('refuses an empty answer', async () => {
    const err = await new Promise((r) => guardedLookup(fakeDns([]))('none.example', {}, (e) => r(e)));
    expect(err).toBeInstanceOf(EgressError);
  });
});

describe('safeFetch — redirects, caps, deadline', () => {
  const hopReturning = (...results: Partial<HopResult>[]) => {
    const fn = vi.fn();
    for (const r of results) fn.mockResolvedValueOnce({ status: 200, headers: {}, body: Buffer.alloc(0), ...r });
    return fn;
  };

  it('re-validates every redirect hop and refuses a redirect to metadata', async () => {
    const hop = hopReturning({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    await expect(safeFetch('https://example.com/', {}, { hop, lookup: vi.fn() })).rejects.toThrow(/cannot be scanned/);
    expect(hop).toHaveBeenCalledTimes(1); // the metadata URL was never requested
  });

  it('refuses a redirect to a non-standard port or scheme', async () => {
    const hop = hopReturning({ status: 301, headers: { location: 'http://example.com:6379/' } });
    await expect(safeFetch('https://example.com/', {}, { hop, lookup: vi.fn() })).rejects.toThrow(/ports/);
    const hop2 = hopReturning({ status: 301, headers: { location: 'file:///etc/passwd' } });
    await expect(safeFetch('https://example.com/', {}, { hop: hop2, lookup: vi.fn() })).rejects.toThrow(/http and https/);
  });

  it('follows public redirects, resolving relative Locations', async () => {
    const hop = hopReturning(
      { status: 301, headers: { location: 'https://www.example.com/' } },
      { status: 302, headers: { location: '/en/' } },
      { status: 200, body: Buffer.from('<h1>ok</h1>') },
    );
    const res = await safeFetch('http://example.com/', {}, { hop, lookup: vi.fn() });
    expect(await res.text()).toBe('<h1>ok</h1>');
    expect(hop.mock.calls.map((c) => (c[0] as URL).toString())).toEqual([
      'http://example.com/', 'https://www.example.com/', 'https://www.example.com/en/',
    ]);
  });

  it('stops after the redirect cap', async () => {
    const loop = { status: 302, headers: { location: 'https://example.com/again' } };
    const hop = hopReturning(loop, loop, loop);
    await expect(safeFetch('https://example.com/', { maxRedirects: 2 }, { hop, lookup: vi.fn() })).rejects.toThrow(/Too many redirects/);
  });

  it('passes non-2xx statuses back to the caller (sites that block bots)', async () => {
    const res = await safeFetch('https://example.com/', {}, { hop: hopReturning({ status: 403 }), lookup: vi.fn() });
    expect(res.status).toBe(403);
  });
});

describe('httpHop against a real local server (lookup bypassed only by using a literal IP)', () => {
  async function withServer(handler: http.RequestListener, run: (base: URL) => Promise<void>) {
    const server = http.createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try { await run(new URL(`http://127.0.0.1:${port}/`)); } finally { server.close(); }
  }
  const opts = (over: Partial<Parameters<typeof httpHop>[1]> = {}) => ({
    method: 'GET' as const, headers: {}, deadline: Date.now() + 2000, maxBytes: 1024, lookup: guardedLookup(), ...over,
  });

  it('caps the body size', () =>
    withServer((_q, s) => s.end('x'.repeat(5000)), async (base) => {
      await expect(httpHop(base, opts())).rejects.toThrow(/too large/);
    }));

  it('caps the DECOMPRESSED size (compression bomb)', () =>
    withServer((_q, s) => {
      s.setHeader('content-encoding', 'gzip');
      s.end(zlib.gzipSync(Buffer.alloc(200_000)));
    }, async (base) => {
      await expect(httpHop(base, opts())).rejects.toThrow(/too large/);
    }));

  it('enforces the deadline', () =>
    withServer(() => { /* never responds */ }, async (base) => {
      await expect(httpHop(base, opts({ deadline: Date.now() + 150 }))).rejects.toMatchObject({ name: 'TimeoutError' });
    }));

  it('decodes gzip and returns status + headers', () =>
    withServer((_q, s) => {
      s.setHeader('content-encoding', 'gzip');
      s.setHeader('x-test', 'yes');
      s.end(zlib.gzipSync('<p>hi</p>'));
    }, async (base) => {
      const r = await httpHop(base, opts());
      expect(r.status).toBe(200);
      expect(r.headers['x-test']).toBe('yes');
      expect(r.body.toString()).toBe('<p>hi</p>');
    }));

  it('a hostname that resolves to loopback never connects', () =>
    withServer((_q, s) => s.end('secret'), async (base) => {
      const url = new URL(`http://localhost:${base.port}/`);
      await expect(httpHop(url, opts())).rejects.toBeInstanceOf(EgressError);
    }));
});
